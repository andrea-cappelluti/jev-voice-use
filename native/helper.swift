// Native macOS helper for desktop mode. One long-running process, spawned by src/desktop.js,
// speaking JSON lines on stdin/stdout:
//
//   events out   {"event":"ready"|"hotkey"|"mic"|"transcript"|"ax", ...}
//   commands in  {"id":N,"cmd":"snapshot"|"click"|"type"|"key"|"shortcut"|"scroll"|"overlay"|"mic"|"hints"|"activate"|"keys"|"probe"|"window"|"quit"|"open_url"|"apps"|"lang"|"config", ...}
//   replies out  {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"..."}
//
// It owns everything Node cannot do: the global hotkey, the microphone + speech recognition,
// reading the frontmost window through the Accessibility API, synthetic clicks / keys / scrolling,
// and the on-screen overlay (mic pill, highlight, numbered candidates).
import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import Speech

// ---------------------------------------------------------------------------------- stdout

let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj), let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    outLock.unlock()
}

/// `VB_DEBUG=1` prints microphone levels and recognizer errors to stderr.
let debugLog = ProcessInfo.processInfo.environment["VB_DEBUG"] != nil
func debug(_ msg: String) {
    if debugLog { FileHandle.standardError.write("[helper] \(msg)\n".data(using: .utf8)!) }
}

// ---------------------------------------------------------------------------------- keys

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "tab": 48, "space": 49, "delete": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "kp0": 82, "kp1": 83, "kp2": 84, "kp3": 85, "kp4": 86, "kp5": 87, "kp6": 88, "kp7": 89, "kp8": 91, "kp9": 92,
    "kpdecimal": 65, "kpmultiply": 67, "kpplus": 69, "kpclear": 71, "kpdivide": 75, "kpenter": 76, "kpminus": 78, "kpequals": 81,
    "=": 24, "-": 27, ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "\\": 42, "`": 50,
    "enter": 36, "backspace": 51, "f11": 103,
]

/// Keypad key names (they carry the numeric-pad flag, which Calculator needs to tell them from the main row).
let keypadKeys: Set<String> = ["kp0", "kp1", "kp2", "kp3", "kp4", "kp5", "kp6", "kp7", "kp8", "kp9", "kpdecimal", "kpmultiply", "kpplus", "kpclear", "kpdivide", "kpenter", "kpminus", "kpequals"]

/// "cmd+shift+3" -> (key code, modifier flags, isKeypad). Modifiers first, the key name last.
func parseChord(_ s: String) -> (CGKeyCode, CGEventFlags, isKeypad: Bool)? {
    var flags: CGEventFlags = []
    let parts = s.lowercased().split(separator: "+", omittingEmptySubsequences: true).map(String.init)
    guard let name = parts.last else { return nil }
    for m in parts.dropLast() {
        switch m {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: return nil
        }
    }
    guard let code = keyCodes[name] else { return nil }
    return (code, flags, keypadKeys.contains(name))
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags = [], keypad: Bool = false) {
    var flags = flags
    if keypad { flags.insert(.maskNumericPad) }
    let src = CGEventSource(stateID: .combinedSessionState)
    for down in [true, false] {
        if let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) {
            e.flags = flags
            e.post(tap: .cghidEventTap)
        }
        usleep(12_000)
    }
}

/// Type text as unicode, independent of the keyboard layout. One key event per character: apps
/// that read key presses themselves (rather than through a text field) only see the first
/// character of a multi-character event.
func postText(_ text: String, delayUs: UInt32 = 7_000) {
    let src = CGEventSource(stateID: .combinedSessionState)
    for ch in text {
        let units = Array(String(ch).utf16)
        for down in [true, false] {
            if let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) {
                e.flags = []
                e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e.post(tap: .cghidEventTap)
            }
        }
        usleep(delayUs)
    }
}

func postClick(at p: CGPoint) {
    let src = CGEventSource(stateID: .combinedSessionState)
    let steps: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp]
    for type in steps {
        if let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) {
            e.flags = []
            e.post(tap: .cghidEventTap)
        }
        usleep(35_000)
    }
}

// ---------------------------------------------------------------------------------- accessibility

func axAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String? { axAttr(el, name) as? String }

func axElement(_ el: AXUIElement, _ name: String) -> AXUIElement? {
    guard let v = axAttr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axElements(_ el: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let v = axAttr(el, name), CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as! [AXUIElement])
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axAttr(el, kAXPositionAttribute), let s = axAttr(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

func clean(_ s: String, max: Int = 120) -> String {
    let t = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    return t.count > max ? String(t.prefix(max)) : t
}

/// Reads the frontmost window and acts on it. Confined to `cmdQueue`.
final class AXBridge {
    struct Info { let role: String; let axRole: String; var frame: CGRect }
    struct Item { let el: AXUIElement; let role: String; let axRole: String; let type: String; var text: String; let placeholder: String; let frame: CGRect; let web: Bool }
    struct Ctx { var out: [Item] = []; var seen = Set<AXUIElement>(); var visited = 0; var truncated = false; var url: String?; var deadline: Date }
    struct Props {
        var role = "", subrole = "", title = "", desc = "", placeholder = "", help = ""
        var frame: CGRect?
        var children: [AXUIElement] = []
        var enabled = true
        var value: String?
        var selected = false
    }

    static let attrs: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute,
        kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute, kAXEnabledAttribute,
        kAXValueAttribute, kAXSelectedAttribute,
    ]
    // Roles where AXPress is the natural activation; everything else gets a real mouse click.
    static let pressRoles: Set<String> = ["button", "link", "checkbox", "switch", "radio", "tab", "popup", "menuitem", "menu"]
    static let singleLine: Set<String> = ["AXTextField", "AXSearchField", "AXComboBox"]
    static let chromium = ["com.google.Chrome", "org.chromium.Chromium", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]

    /// Bundle-id prefixes of web browsers (same list as BROWSER_BUNDLE_PREFIXES in src/constants.js).
    static let browserBundles = ["com.google.Chrome", "org.chromium.Chromium", "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac", "com.brave.Browser", "org.mozilla.firefox", "com.operasoftware.Opera", "com.vivaldi.Vivaldi"]
    func isBrowser(_ app: NSRunningApplication) -> Bool {
        let b = app.bundleIdentifier ?? ""
        return AXBridge.browserBundles.contains { b.hasPrefix($0) }
    }

    var idByElement: [AXUIElement: String] = [:]
    var elementById: [String: AXUIElement] = [:]
    var infoById: [String: Info] = [:]
    var nextId = 1
    var pid: pid_t = 0
    var manualAX = Set<pid_t>()
    var windowFrame = CGRect.zero

    func props(_ el: AXUIElement) -> Props? {
        var out: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, AXBridge.attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
              let arr = out as? [AnyObject], arr.count == AXBridge.attrs.count else { return nil }
        var p = Props()
        p.role = (arr[0] as? String) ?? ""
        p.subrole = (arr[1] as? String) ?? ""
        p.title = (arr[2] as? String) ?? ""
        p.desc = (arr[3] as? String) ?? ""
        p.placeholder = (arr[4] as? String) ?? ""
        p.help = (arr[5] as? String) ?? ""
        var pt = CGPoint.zero
        var sz = CGSize.zero
        if CFGetTypeID(arr[6]) == AXValueGetTypeID(), CFGetTypeID(arr[7]) == AXValueGetTypeID(),
           AXValueGetValue(arr[6] as! AXValue, .cgPoint, &pt), AXValueGetValue(arr[7] as! AXValue, .cgSize, &sz) {
            p.frame = CGRect(origin: pt, size: sz)
        }
        if CFGetTypeID(arr[8]) == CFArrayGetTypeID() { p.children = arr[8] as! [AXUIElement] }
        if CFGetTypeID(arr[9]) == CFBooleanGetTypeID() { p.enabled = (arr[9] as? Bool) ?? true }
        p.value = arr[10] as? String
        if CFGetTypeID(arr[11]) == CFBooleanGetTypeID() { p.selected = (arr[11] as? Bool) ?? false }
        return p
    }

    func mapRole(_ p: Props, web: Bool, inRow: Bool) -> String? {
        switch p.role {
        case "AXButton", "AXMenuButton", "AXDisclosureTriangle": return "button"
        case "AXLink": return "link"
        case "AXSearchField": return "searchbox"
        // Inside a native table row a text field is just the row's label (Finder file names).
        case "AXTextField": return inRow ? nil : (p.subrole == "AXSearchField" ? "searchbox" : "textbox")
        case "AXTextArea": return "textbox"
        case "AXComboBox": return "combobox"
        case "AXCheckBox": return (p.subrole == "AXSwitch" || p.subrole == "AXToggle") ? "switch" : "checkbox"
        case "AXSwitch": return "switch"
        case "AXRadioButton": return p.subrole == "AXTabButton" ? "tab" : "radio"
        case "AXTab": return "tab"
        case "AXPopUpButton": return "popup"
        case "AXMenuItem": return "menuitem"
        case "AXMenuBarItem": return "menu"
        case "AXRow": return web ? nil : "row"
        case "AXImage": return (!web && !(p.title.isEmpty && p.desc.isEmpty)) ? "item" : nil
        default: return nil
        }
    }

    /// The element's own label. Text-input values are never used: they are the user's content.
    func label(_ p: Props, role: String) -> String {
        switch p.subrole {
        case "AXCloseButton": return "Close window / Chiudi finestra"
        case "AXMinimizeButton": return "Minimize window / Riduci a icona"
        case "AXZoomButton", "AXFullScreenButton": return "Zoom window / Zoom finestra"
        default: break
        }
        var l = p.title
        if l.isEmpty { l = p.desc }
        if l.isEmpty, role == "popup" { l = p.value ?? "" }
        if l.isEmpty, ["textbox", "searchbox", "combobox"].contains(role) { l = p.placeholder }
        if l.isEmpty { l = p.help }
        return clean(l)
    }

    /// Depth-first walk. Returns the visible texts of the subtree so an unlabeled interactive
    /// ancestor (a link, a table row) can be named after its content.
    func visit(_ el: AXUIElement, depth: Int, web: Bool, inRow: Bool, clip: CGRect?, host: CGRect?, ctx: inout Ctx) -> [String] {
        if depth > 60 || ctx.visited >= 4000 || ctx.out.count >= 260 || Date() > ctx.deadline {
            ctx.truncated = true
            return []
        }
        // Some apps (Chrome) expose the same toolbar under several parents.
        guard ctx.seen.insert(el).inserted else { return [] }
        ctx.visited += 1
        guard let p = props(el) else { return [] }
        let solid = { (r: CGRect?) -> CGRect? in (r.map { $0.width > 1 && $0.height > 1 } ?? false) ? r : nil }
        var clip = clip
        if p.role == "AXMenu" {
            // A menu that is not on screen reports no usable frame; an open one may overflow the window.
            guard let f = p.frame, f.width > 4, f.height > 4 else { return [] }
            clip = nil
        }
        if let f = solid(p.frame), let c = clip, !f.intersects(c) { return [] }
        // Content that is scrolled out of view is cut off by its scroll container. Nothing is
        // clipped against the window itself: Chrome's window frame excludes its own tabs and toolbar.
        if p.role == "AXScrollArea", let f = solid(p.frame) { clip = clip.map { $0.intersection(f) } ?? f }

        var isWeb = web
        if p.role == "AXWebArea" {
            isWeb = true
            if ctx.url == nil, let u = axAttr(el, "AXURL") { ctx.url = (u as? URL)?.absoluteString ?? (u as? String) }
            // A web area can be as tall as the whole document; its parent is the visible viewport.
            for f in [solid(p.frame), solid(host)].compactMap({ $0 }) { clip = clip.map { $0.intersection(f) } ?? f }
        }

        let mapped = mapRole(p, web: isWeb, inRow: inRow)
        var slot: Int?
        var own = ""
        if let role = mapped, p.enabled, let f = p.frame, f.width >= 4, f.height >= 4 {
            own = label(p, role: role)
            slot = ctx.out.count
            ctx.out.append(Item(el: el, role: role, axRole: p.role, type: p.subrole, text: own, placeholder: clean(p.placeholder, max: 60), frame: f, web: isWeb))
        }

        var texts: [String] = []
        if p.role == "AXStaticText" || (inRow && p.role == "AXTextField") {
            let t = clean(p.value ?? p.title, max: 80)
            if !t.isEmpty { texts.append(t) }
        }

        var kids = p.children
        if p.role == "AXTable" || p.role == "AXOutline" {
            let rows = axElements(el, kAXVisibleRowsAttribute)
            if !rows.isEmpty { kids = rows }
        }
        // Closed menus keep their items in the tree; only walk into the ones that are open.
        let closedMenu = (p.role == "AXMenuBarItem" || p.role == "AXMenuItem") && !p.selected
        if !closedMenu {
            for c in kids {
                let t = visit(c, depth: depth + 1, web: isWeb, inRow: inRow || p.role == "AXRow", clip: clip, host: solid(p.frame) ?? host, ctx: &ctx)
                if texts.count < 4 { texts.append(contentsOf: t.prefix(4 - texts.count)) }
            }
        }
        if let s = slot, ctx.out[s].text.isEmpty { ctx.out[s].text = clean(texts.prefix(3).joined(separator: " ")) }
        return own.isEmpty ? texts : [own]
    }

    func frontApp() -> (NSRunningApplication, AXUIElement)? {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid() else { return nil }
        return (app, AXUIElementCreateApplication(app.processIdentifier))
    }

    func focusedWindow(_ appEl: AXUIElement) -> AXUIElement? {
        axElement(appEl, kAXFocusedWindowAttribute) ?? axElement(appEl, kAXMainWindowAttribute) ?? axElements(appEl, kAXWindowsAttribute).first
    }

    func idFor(_ el: AXUIElement) -> String {
        if let id = idByElement[el] { return id }
        let id = String(format: "e%02d", nextId)
        nextId += 1
        idByElement[el] = id
        elementById[id] = el
        return id
    }

    func snapshot() -> [String: Any] {
        let t0 = Date()
        guard AXIsProcessTrusted() else { return ["error": "accessibility permission not granted"] }
        guard let (app, appEl) = frontApp() else { return ["error": "no frontmost application"] }
        let newPid = app.processIdentifier
        // Ids stay stable while the same app is in front (a decision may be executed against a
        // slightly newer snapshot) and are never reused for a different element.
        if newPid != pid || idByElement.count > 4000 {
            pid = newPid
            idByElement.removeAll()
            elementById.removeAll()
            infoById.removeAll()
        }
        if !manualAX.contains(newPid) {
            manualAX.insert(newPid)
            // Electron and Chromium browsers only build the accessibility tree of their web content
            // when asked: Electron through AXManualAccessibility, the browsers through the flag
            // VoiceOver sets.
            AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            let bundle = app.bundleIdentifier ?? ""
            if AXBridge.chromium.contains(where: { bundle.hasPrefix($0) }) {
                AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            }
        }

        var ctx = Ctx(deadline: t0.addingTimeInterval(0.8))
        var title = ""
        var wf = CGRect.zero
        if let win = focusedWindow(appEl) {
            title = axString(win, kAXTitleAttribute) ?? ""
            wf = axFrame(win) ?? .zero
            if let doc = axString(win, kAXDocumentAttribute), doc.hasPrefix("http") { ctx.url = doc }
            _ = visit(win, depth: 0, web: false, inRow: false, clip: nil, host: nil, ctx: &ctx)
        }
        let truncated = ctx.truncated
        if let bar = axElement(appEl, kAXMenuBarAttribute) {
            ctx.deadline = Date().addingTimeInterval(0.25)
            _ = visit(bar, depth: 0, web: false, inRow: false, clip: nil, host: nil, ctx: &ctx)
        }
        windowFrame = wf

        var elements: [[String: Any]] = []
        for item in ctx.out {
            let f = item.frame
            guard f.origin.x.isFinite, f.origin.y.isFinite, f.width.isFinite, f.height.isFinite else { continue }
            let id = idFor(item.el)
            infoById[id] = Info(role: item.role, axRole: item.axRole, frame: f)
            elements.append([
                "id": id, "role": item.role, "type": item.type, "text": item.text, "placeholder": item.placeholder,
                "left": Int(f.minX), "top": Int(f.minY), "w": Int(f.width), "h": Int(f.height), "web": item.web,
            ])
        }
        var out: [String: Any] = [
            "app": app.localizedName ?? "", "title": clean(title), "elements": elements,
            "truncated": truncated, "ms": Int(Date().timeIntervalSince(t0) * 1000),
            "bundle": app.bundleIdentifier ?? "", "browser": isBrowser(app),
        ]
        if let u = ctx.url, u.hasPrefix("http") { out["url"] = u }
        return out
    }

    /// Bring an already running application to the front. `open -a` would do it too, but it also
    /// sends a "reopen" that some apps answer with an extra window (Chrome: its profile picker).
    /// Reports `activated: false` when the app is not running or has no window to show.
    func activate(_ name: String) -> [String: Any] {
        let match = NSWorkspace.shared.runningApplications.first {
            $0.bundleURL?.deletingPathExtension().lastPathComponent == name || $0.localizedName == name
        }
        guard let app = match else { return ["activated": false] }
        let windows = axElements(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute)
        guard windows.contains(where: { (axAttr($0, kAXMinimizedAttribute) as? Bool) != true }) else { return ["activated": false] }
        return ["activated": app.activate()]
    }

    func currentFrame(_ id: String) -> CGRect? {
        guard let el = elementById[id] else { return nil }
        if let f = axFrame(el), f.width > 1, f.height > 1 {
            infoById[id]?.frame = f
            return f
        }
        return infoById[id]?.frame
    }

    func click(_ id: String) -> [String: Any] {
        guard let el = elementById[id], let info = infoById[id], let f = currentFrame(id) else {
            return ["error": "element \(id) is no longer on screen"]
        }
        if AXBridge.pressRoles.contains(info.role) {
            let r = AXUIElementPerformAction(el, kAXPressAction as CFString)
            // cannotComplete = the app is busy handling the press (a menu or a sheet opened): it did happen.
            if r == .success || r == .cannotComplete { return ["via": "press"] }
        }
        postClick(at: CGPoint(x: f.midX, y: f.midY))
        return ["via": "mouse"]
    }

    /// Type into `id` (or wherever the keyboard focus is when `id` is nil). Single-line fields are
    /// replaced; multi-line text is inserted at the cursor so a document is never wiped.
    func type(_ id: String?, text: String, submit: Bool) -> [String: Any] {
        var single = false
        if let id = id {
            guard let el = elementById[id], let info = infoById[id], let f = currentFrame(id) else {
                return ["error": "element \(id) is no longer on screen"]
            }
            single = AXBridge.singleLine.contains(info.axRole)
            if single || AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) != .success {
                postClick(at: CGPoint(x: f.midX, y: f.midY))
            }
            usleep(120_000)
        }
        if single {
            postKey(keyCodes["a"]!, flags: .maskCommand)
            if text.isEmpty { postKey(keyCodes["delete"]!) }
        } else if text.isEmpty {
            _ = shortcut("z", shift: false, alt: false, ctrl: false) // "clear what I just typed" = undo
        }
        postText(text)
        if submit {
            usleep(90_000)
            postKey(keyCodes["return"]!)
        }
        return [:]
    }

    /// Trigger Cmd+<char> by pressing the menu item that owns that key equivalent. Unlike a synthetic
    /// keystroke this is independent of the keyboard layout (Cmd+[ is not where it seems on non-US
    /// keyboards). When no menu item matches (Chrome fills its History menu lazily) it falls back
    /// to a keystroke: Cmd+`fallback` if given (a layout-independent equivalent), else Cmd+`char`.
    func shortcut(_ char: String, shift: Bool, alt: Bool, ctrl: Bool, fallback: String? = nil) -> [String: Any] {
        let want = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0)
        if let (_, appEl) = frontApp(), let bar = axElement(appEl, kAXMenuBarAttribute) {
            for barItem in axElements(bar, kAXChildrenAttribute).dropFirst() {
                for menu in axElements(barItem, kAXChildrenAttribute) {
                    for item in axElements(menu, kAXChildrenAttribute) {
                        guard let c = axString(item, kAXMenuItemCmdCharAttribute), c.lowercased() == char.lowercased(),
                              ((axAttr(item, kAXMenuItemCmdModifiersAttribute) as? Int) ?? -1) == want else { continue }
                        if (axAttr(item, kAXEnabledAttribute) as? Bool) == false { return ["via": "menu", "disabled": true] }
                        let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
                        if r == .success || r == .cannotComplete { return ["via": "menu"] }
                    }
                }
            }
        }
        guard let code = keyCodes[(fallback ?? char).lowercased()] else { return ["error": "unknown key \(fallback ?? char)"] }
        var flags: CGEventFlags = .maskCommand
        if shift { flags.insert(.maskShift) }
        if alt { flags.insert(.maskAlternate) }
        if ctrl { flags.insert(.maskControl) }
        postKey(code, flags: flags)
        return ["via": "key"]
    }

    func key(_ name: String, mods: [String]) -> [String: Any] {
        guard let (code, flags, keypad) = parseChord((mods + [name]).joined(separator: "+")) else { return ["error": "unknown key \(name)"] }
        postKey(code, flags: flags, keypad: keypad)
        return [:]
    }

    /// Post several chords in order. All are validated first so a typo never sends half a sequence.
    func keys(_ chords: [String], delayMs: Int) -> [String: Any] {
        var parsed: [(CGKeyCode, CGEventFlags, Bool)] = []
        for c in chords {
            guard let p = parseChord(c) else { return ["error": "unknown key \(c)"] }
            parsed.append((p.0, p.1, p.isKeypad))
        }
        for (i, p) in parsed.enumerated() {
            postKey(p.0, flags: p.1, keypad: p.2)
            if i < parsed.count - 1 && delayMs > 0 { usleep(UInt32(delayMs) * 1000) }
        }
        return ["sent": parsed.count]
    }

    /// Cheap description of the frontmost window: no tree walk.
    func probe() -> [String: Any] {
        guard let (app, appEl) = frontApp() else { return ["error": "no frontmost application"] }
        // `bundleName` is the .app folder name ("Visual Studio Code") next to the display name ("Code"): either can be the one
        // an application was asked for by.
        var out: [String: Any] = [
            "app": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "browser": isBrowser(app),
            "bundleName": app.bundleURL?.deletingPathExtension().lastPathComponent ?? "",
        ]
        guard AXIsProcessTrusted() else { return out }
        if let win = focusedWindow(appEl) {
            out["title"] = clean(axString(win, kAXTitleAttribute) ?? "")
            if let doc = axString(win, kAXDocumentAttribute), doc.hasPrefix("http") { out["url"] = doc }
        }
        return out
    }

    /// Press the close / minimize / full-screen / zoom button of the focused window.
    func window(_ op: String) -> [String: Any] {
        let attr: String
        switch op {
        case "close": attr = kAXCloseButtonAttribute
        case "minimize": attr = kAXMinimizeButtonAttribute
        case "fullscreen": attr = kAXFullScreenButtonAttribute
        case "zoom": attr = kAXZoomButtonAttribute
        default: return ["error": "unknown window op \(op)"]
        }
        guard let (_, appEl) = frontApp(), let win = focusedWindow(appEl) else { return ["error": "no window"] }
        guard let btn = axElement(win, attr) else { return ["error": "window has no \(op) button"] }
        let r = AXUIElementPerformAction(btn, kAXPressAction as CFString)
        guard r == .success || r == .cannotComplete else { return ["error": "window has no \(op) button"] }
        return ["via": "ax"]
    }

    /// Politely ask an app to quit (never a force quit). Frontmost app when `name` is nil.
    func quit(_ name: String?) -> [String: Any] {
        var target: NSRunningApplication?
        if let n = name, !n.isEmpty {
            let l = n.lowercased()
            target = NSWorkspace.shared.runningApplications.first {
                $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == l || $0.localizedName?.lowercased() == l
            }
        } else {
            target = NSWorkspace.shared.frontmostApplication
        }
        guard let app = target else { return ["quit": false, "app": name ?? ""] }
        let label = app.localizedName ?? name ?? ""
        if app.processIdentifier == getpid() || app.bundleIdentifier == "com.apple.finder" { return ["quit": false, "app": label] }
        return ["quit": app.terminate(), "app": label]
    }

    /// Is the keyboard focus outside the page (the address bar, a toolbar field), judged from the accessibility tree?
    /// nil = cannot tell (the browser does not expose its focus).
    func focusIsOutsideWebArea(_ appEl: AXUIElement) -> Bool? {
        guard let focused = axElement(appEl, kAXFocusedUIElementAttribute) else { return nil }
        var el: AXUIElement? = focused
        var depth = 0
        while let e = el, depth < 40 {
            if axString(e, kAXRoleAttribute) == "AXWebArea" { return false }
            el = axElement(e, kAXParentAttribute)
            depth += 1
        }
        return true
    }

    /// Navigate the frontmost browser's CURRENT tab (or a new one) through its address bar. Cmd+L is "focus the address bar"
    /// in every browser, so it is sent as a plain key press (looking the menu item up over AX walks every menu first). The
    /// focus is then CHECKED before anything is typed: when it is still inside the page the URL and the Return would go into
    /// a form field, so this reports an error and the caller falls back to `open`.
    func openURL(_ url: String, newTab: Bool) -> [String: Any] {
        guard url.hasPrefix("http://") || url.hasPrefix("https://") else { return ["error": "invalid url"] }
        guard let (app, appEl) = frontApp(), isBrowser(app) else { return ["error": "not a browser"] }
        if newTab { postKey(keyCodes["t"]!, flags: .maskCommand); usleep(120_000) }
        postKey(keyCodes["l"]!, flags: .maskCommand)
        var outside: Bool?
        for _ in 0..<10 {
            usleep(30_000)
            outside = focusIsOutsideWebArea(appEl)
            if outside != false { break }
        }
        if outside == false { return ["error": "address bar not focused"] }
        postText(url, delayUs: 1_500)
        postKey(keyCodes["forwarddelete"]!) // drops the omnibox's inline autocompletion
        postKey(keyCodes["return"]!)
        return ["via": "omnibox"]
    }

    /// Installed apps in `dirs` (non-recursive): bundle dir name and the name Finder shows.
    func apps(_ dirs: [String]) -> [String: Any] {
        var list: [[String: String]] = []
        let fm = FileManager.default
        for dir in dirs {
            let names = ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".app") }.sorted()
            for n in names {
                var display = fm.displayName(atPath: (dir as NSString).appendingPathComponent(n))
                if display.hasSuffix(".app") { display = String(display.dropLast(4)) }
                list.append(["name": String(n.dropLast(4)), "display": display])
            }
        }
        // "apri il browser": the app that opens web links.
        let browser = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!)?.deletingPathExtension().lastPathComponent
        return ["apps": list, "defaultBrowser": browser ?? ""]
    }

    /// Role of the element holding the keyboard focus in the front app ("" when nothing has it).
    func focus() -> [String: Any] {
        guard let (_, appEl) = frontApp(), let el = axElement(appEl, kAXFocusedUIElementAttribute) else { return ["role": ""] }
        return ["role": axString(el, kAXRoleAttribute) ?? ""]
    }

    /// Scroll the focused window. Wheel events go to whatever is under the pointer, so the pointer
    /// is moved into the window first when it is somewhere else.
    func scroll(down: Bool, amount: String) -> [String: Any] {
        var wf = windowFrame
        if let (_, appEl) = frontApp(), let win = focusedWindow(appEl), let f = axFrame(win) { wf = f }
        if wf.isEmpty { wf = CGDisplayBounds(CGMainDisplayID()) }
        let pointer = CGEvent(source: nil)?.location ?? .zero
        if !wf.insetBy(dx: 24, dy: 24).contains(pointer) {
            let center = CGPoint(x: wf.midX, y: wf.midY)
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
            usleep(60_000)
        }
        let total: CGFloat = amount == "little" ? wf.height * 0.35 : (amount == "end" ? 240_000 : wf.height * 0.85)
        let steps = amount == "end" ? 40 : 12
        let step = Int32((total / CGFloat(steps)).rounded()) * (down ? -1 : 1)
        for _ in 0..<steps {
            CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: step, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
            usleep(9_000)
        }
        return ["px": Int(total)]
    }
}

// ---------------------------------------------------------------------------------- overlay

/// Click-through, always-on-top feedback: the mic pill, the flash on the element being acted on,
/// and numbered badges when Jev is unsure which element was meant.
@MainActor final class Overlay {
    static let shared = Overlay()
    var micOn = false
    var transcript = ""
    var transcriptUntil = Date.distantPast
    var listeningText = "Listening…"
    var micOffText = "Mic off"
    var toast = ""
    var toastUntil = Date.distantPast
    var highlight = CGRect.zero
    var highlightUntil = Date.distantPast
    var candidates: [(Int, CGRect)] = []
    var candidatesUntil = Date.distantPast
    private var windows: [NSWindow] = []
    private var timer: Timer?

    func start() {
        rebuild()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Overlay.shared.rebuild() }
        }
        // Expiries (toast, highlight, badges) are picked up by a slow redraw tick.
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
            MainActor.assumeIsolated { Overlay.shared.redraw() }
        }
    }

    func rebuild() {
        for w in windows { w.orderOut(nil) }
        windows = []
        guard let primary = NSScreen.screens.first else { return }
        for (i, screen) in NSScreen.screens.enumerated() {
            // A non-activating panel: showing it must never take the focus away from the user's app.
            let w = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.level = .screenSaver
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            let v = OverlayView(frame: CGRect(origin: .zero, size: screen.frame.size))
            // Accessibility coordinates have their origin at the top-left of the primary screen.
            v.originAX = CGPoint(x: screen.frame.minX, y: primary.frame.height - screen.frame.maxY)
            v.isPrimary = i == 0
            w.contentView = v
            w.setFrame(screen.frame, display: true)
            w.orderFrontRegardless()
            windows.append(w)
        }
    }

    func redraw() { for w in windows { w.contentView?.needsDisplay = true } }

    func setMic(_ on: Bool) { micOn = on; transcript = ""; redraw() }
    func setTranscript(_ t: String) { transcript = t; transcriptUntil = Date().addingTimeInterval(3); redraw() }
    func showToast(_ t: String, ms: Double) { toast = t; toastUntil = Date().addingTimeInterval(ms / 1000); redraw() }
    func showHighlight(_ r: CGRect, ms: Double) { highlight = r; highlightUntil = Date().addingTimeInterval(ms / 1000); redraw() }
    func showCandidates(_ c: [(Int, CGRect)], ms: Double) { candidates = c; candidatesUntil = Date().addingTimeInterval(ms / 1000); redraw() }
    func clearCandidates() { candidates = []; candidatesUntil = Date.distantPast; redraw() }
}

final class OverlayView: NSView {
    var originAX = CGPoint.zero
    var isPrimary = false
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let s = Overlay.shared
        let now = Date()
        let local = { (r: CGRect) in r.offsetBy(dx: -self.originAX.x, dy: -self.originAX.y) }

        if now < s.highlightUntil {
            let path = NSBezierPath(roundedRect: local(s.highlight).insetBy(dx: -3, dy: -3), xRadius: 6, yRadius: 6)
            NSColor.systemOrange.withAlphaComponent(0.18).setFill()
            path.fill()
            NSColor.systemOrange.setStroke()
            path.lineWidth = 3
            path.stroke()
        }
        if now < s.candidatesUntil {
            for (n, rect) in s.candidates {
                let r = local(rect).insetBy(dx: -2, dy: -2)
                let path = NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5)
                NSColor.systemBlue.setStroke()
                path.lineWidth = 2.5
                path.stroke()
                let badge = CGRect(x: r.minX - 12, y: r.minY - 12, width: 26, height: 26)
                NSColor.systemBlue.setFill()
                NSBezierPath(ovalIn: badge).fill()
                let str = NSAttributedString(string: "\(n)", attributes: [.font: NSFont.boldSystemFont(ofSize: 15), .foregroundColor: NSColor.white])
                let sz = str.size()
                str.draw(at: CGPoint(x: badge.midX - sz.width / 2, y: badge.midY - sz.height / 2))
            }
        }

        guard isPrimary else { return }
        var text: String?
        if now < s.toastUntil { text = s.toast }
        else if s.micOn { text = (now < s.transcriptUntil && !s.transcript.isEmpty) ? s.transcript : s.listeningText }
        guard var t = text else { return }
        if t.count > 90 { t = "…" + String(t.suffix(90)) }
        let str = NSAttributedString(string: t, attributes: [.font: NSFont.systemFont(ofSize: 16, weight: .medium), .foregroundColor: NSColor.white])
        let sz = str.size()
        let dot: CGFloat = s.micOn ? 20 : 0
        let pill = CGRect(x: (bounds.width - sz.width - 36 - dot) / 2, y: 52, width: sz.width + 36 + dot, height: 38)
        NSColor(calibratedWhite: 0.07, alpha: 0.9).setFill()
        NSBezierPath(roundedRect: pill, xRadius: 19, yRadius: 19).fill()
        if s.micOn {
            NSColor.systemRed.setFill()
            NSBezierPath(ovalIn: CGRect(x: pill.minX + 16, y: pill.midY - 5, width: 10, height: 10)).fill()
        }
        str.draw(at: CGPoint(x: pill.minX + 18 + dot, y: pill.midY - sz.height / 2))
    }
}

// ---------------------------------------------------------------------------------- speech

/// Holds the current recognition request for the audio thread.
final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); request = r; lock.unlock() }
    func append(_ buffer: AVAudioPCMBuffer) { lock.lock(); let r = request; lock.unlock(); r?.append(buffer) }
}

// These closures run on the audio / recognizer threads, so they are built outside any actor.
func makeTap(_ box: RequestBox) -> AVAudioNodeTapBlock {
    guard debugLog else { return { buffer, _ in box.append(buffer) } }
    var buffers = 0
    var peak: Float = 0
    var last = Date()
    return { buffer, _ in
        box.append(buffer)
        buffers += 1
        if let ch = buffer.floatChannelData?[0] {
            for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(ch[i])) }
        }
        if Date().timeIntervalSince(last) >= 1 {
            debug("audio: \(buffers) buffers/s, peak level \(String(format: "%.3f", peak)), format \(buffer.format.sampleRate) Hz x\(buffer.format.channelCount)")
            buffers = 0; peak = 0; last = Date()
        }
    }
}

func makeResultHandler(gen: Int) -> (SFSpeechRecognitionResult?, Error?) -> Void {
    return { result, error in
        let text = result?.bestTranscription.formattedString
        let isFinal = result?.isFinal ?? false
        let failure = error?.localizedDescription
        // "No speech detected" (1110) and cancellations (216, 301) are a quiet room or our own task switch.
        let quiet = (error as NSError?).map { [1110, 216, 301].contains($0.code) } ?? true
        if let e = error { debug("recognizer: \(e)") }
        DispatchQueue.main.async { SpeechInput.shared.handle(gen: gen, text: text, isFinal: isFinal, failure: failure, quiet: quiet) }
    }
}

func requestSpeechPermissions(_ done: @escaping @MainActor (String?) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
        guard status == .authorized else {
            DispatchQueue.main.async { done("speech recognition permission denied (System Settings → Privacy & Security → Speech Recognition)") }
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
            DispatchQueue.main.async { done(ok ? nil : "microphone permission denied (System Settings → Privacy & Security → Microphone)") }
        }
    }
}

/// Microphone → streaming partial transcripts. The recognizer never ends an utterance on its own
/// while audio keeps flowing, so an utterance is closed after `silenceSeconds` without new words
/// and a fresh recognition task is started for the next one.
@MainActor final class SpeechInput {
    static let shared = SpeechInput()
    // Smart end of utterance: a short silence closes a phrase that looks finished, a long one a
    // phrase that ends on a word expecting continuation. Defaults mirror src/constants.js, which
    // Node re-sends through `config` at launch.
    var silenceShortMs = 650
    var silenceLongMs = 1700
    var continuationWords: Set<String> = [
        "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
        "del", "dello", "della", "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle", "dal", "dallo", "dalla",
        "dai", "dagli", "dalle", "nel", "nello", "nella", "nei", "negli", "nelle", "sul", "sullo", "sulla", "sui", "sugli", "sulle",
        "e", "o", "ma", "che", "come", "se", "più", "meno", "diviso", "fratto", "moltiplicato", "mio", "mia", "miei", "mie",
        "tuo", "tua", "suo", "sua", "quel", "quanto",
        "the", "a", "an", "of", "to", "for", "in", "on", "with", "and", "or", "at", "from", "into", "by", "about", "as", "than",
        "plus", "minus", "times", "divided", "multiplied", "over", "my", "your", "his", "her", "their", "our",
        "these", "those", "what", "+", "-", "*", "/", "×", "÷",
    ]
    var verbOnlyWords: Set<String> = [
        "apri", "cerca", "vai", "scrivi", "digita", "clicca", "premi", "seleziona", "scegli", "fai", "calcola", "trova", "avvia",
        "lancia", "passa", "metti", "imposta", "chiudi", "esci", "open", "search", "go", "type", "write", "click", "press",
        "select", "choose", "calculate", "find", "launch", "start", "switch", "set", "look", "enter", "fill", "visit", "take",
        "close", "quit", "show", "google",
    ]
    var localeId = "en-US"
    var hints: [String] = []
    private var recognizer: SFSpeechRecognizer?
    private let engine = AVAudioEngine()
    private let box = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private var on = false
    private var starting = false
    private var gen = 0
    private var utterance = 0
    private var lastText = ""
    private var taskStartedAt = Date()
    private var fastFails = 0
    private var silence: Timer?
    private var engineObserver: NSObjectProtocol?
    private var lastFailure: String?

    func toggle() { (on || starting) ? stop(nil) : start() }

    func set(_ wanted: Bool) {
        if wanted { start() } else if on || starting { stop(nil) }
    }

    func start() {
        guard !on, !starting else { return }
        starting = true
        requestSpeechPermissions { err in
            let me = SpeechInput.shared
            guard me.starting else { return } // toggled off while the permission prompt was up
            me.starting = false
            if let err = err { me.report(err) } else { me.begin() }
        }
    }

    private func report(_ error: String) {
        Overlay.shared.showToast("\(Overlay.shared.micOffText) — \(error)", ms: 6000)
        emit(["event": "mic", "on": false, "error": error])
    }

    private func begin() {
        if recognizer == nil { recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) }
        guard let rec = recognizer, rec.isAvailable else { report("speech recognizer unavailable for \(localeId)"); return }
        if let err = startEngine() { report(err); return }
        if engineObserver == nil {
            engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
                MainActor.assumeIsolated { SpeechInput.shared.resumeAudio(retries: 3) }
            }
        }
        on = true
        fastFails = 0
        beginTask()
        NSSound(named: "Tink")?.play()
        Overlay.shared.setMic(true)
        emit(["event": "mic", "on": true, "onDevice": rec.supportsOnDeviceRecognition])
    }

    /// Taps the current input device and starts the engine; returns an error message on failure.
    private func startEngine() -> String? {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return "no microphone input available" }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: makeTap(box))
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            return "audio engine: \(error.localizedDescription)"
        }
        return nil
    }

    /// The OS stops the engine whenever the audio device configuration changes: a Bluetooth headset
    /// switching to its microphone profile does it right after start, plugging or unplugging one too.
    /// Re-tap the new device and start a fresh recognition task for its format.
    func resumeAudio(retries: Int) {
        guard on, !engine.isRunning else { return }
        debug("audio configuration changed, restarting the engine")
        if let err = startEngine() {
            // The new device is often not ready yet while a Bluetooth profile switch settles.
            if retries == 0 { stop(err); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { SpeechInput.shared.resumeAudio(retries: retries - 1) }
            return
        }
        endUtterance(failure: nil)
    }

    private func beginTask() {
        guard let rec = recognizer else { return }
        task?.cancel()
        gen += 1
        utterance += 1
        lastText = ""
        taskStartedAt = Date()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.addsPunctuation = false
        if !hints.isEmpty { req.contextualStrings = hints }
        box.set(req)
        task = rec.recognitionTask(with: req, resultHandler: makeResultHandler(gen: gen))
    }

    func handle(gen g: Int, text: String?, isFinal: Bool, failure: String?, quiet: Bool) {
        guard on, g == gen else { return }
        // Report a real failure once, not on every retry, so it reaches the terminal without VB_DEBUG.
        if let f = failure, !quiet, f != lastFailure {
            lastFailure = f
            emit(["event": "speech_error", "error": f])
        }
        if let t = text, !t.isEmpty, t != lastText {
            lastText = t
            lastFailure = nil
            fastFails = 0
            emit(["event": "transcript", "text": t, "final": false, "utteranceId": "u\(utterance)"])
            Overlay.shared.setTranscript(t)
            silence?.invalidate()
            silence = Timer.scheduledTimer(withTimeInterval: self.expectsContinuation(t) ? Double(silenceLongMs) / 1000 : Double(silenceShortMs) / 1000, repeats: false) { _ in
                MainActor.assumeIsolated { SpeechInput.shared.endUtterance(failure: nil) }
            }
        }
        if isFinal || failure != nil { endUtterance(failure: failure) }
    }

    /// True when the phrase probably goes on: it ends in an elision (dell', l'), in a function word
    /// that needs a complement, or it is a lone verb ("cerca", "open").
    func expectsContinuation(_ text: String) -> Bool {
        var t = text.lowercased()
        while let l = t.last, ".,;:!? ".contains(l) || l.isWhitespace { t.removeLast() }
        let tokens = t.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let last = tokens.last else { return false }
        // "scorri un po'", "ingrandisci di più" are finished phrases; the elision rule is for "dell'", "l'".
        if last == "po'" || last == "po\u{2019}" { return false }
        if (last == "più" || last == "meno") && tokens.count >= 2 && tokens[tokens.count - 2] == "di" { return false }
        if last.hasSuffix("'") || last.hasSuffix("\u{2019}") { return true }
        if continuationWords.contains(last) { return true }
        return tokens.count == 1 && verbOnlyWords.contains(last)
    }

    /// Switch the recognizer locale live. Keeps the old one when the new one is unavailable.
    func setLocale(_ id: String) -> String? {
        guard let rec = SFSpeechRecognizer(locale: Locale(identifier: id)), rec.isAvailable else {
            return "speech recognizer unavailable for \(id)"
        }
        localeId = id
        recognizer = rec
        if on {
            gen += 1
            silence?.invalidate()
            silence = nil
            box.set(nil)
            beginTask()
        }
        return nil
    }

    private func endUtterance(failure: String?) {
        silence?.invalidate()
        silence = nil
        guard on else { return }
        if !lastText.isEmpty {
            emit(["event": "transcript", "text": lastText, "final": true, "utteranceId": "u\(utterance)"])
        } else if let failure = failure, Date().timeIntervalSince(taskStartedAt) < 1 {
            // Failing straight away, repeatedly, is a broken recognizer — not a quiet room.
            fastFails += 1
            if fastFails >= 5 { stop("speech recognition keeps failing: \(failure)"); return }
        }
        gen += 1 // drop late callbacks of the task being replaced
        box.set(nil)
        if failure == nil { beginTask(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if SpeechInput.shared.on { SpeechInput.shared.beginTask() }
        }
    }

    func stop(_ error: String?) {
        starting = false
        guard on else { return }
        on = false
        gen += 1
        silence?.invalidate()
        silence = nil
        task?.cancel()
        task = nil
        box.set(nil)
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        NSSound(named: "Pop")?.play()
        Overlay.shared.setMic(false)
        Overlay.shared.showToast(error.map { "\(Overlay.shared.micOffText) — \($0)" } ?? Overlay.shared.micOffText, ms: error == nil ? 1200 : 6000)
        var ev: [String: Any] = ["event": "mic", "on": false]
        if let e = error { ev["error"] = e }
        emit(ev)
    }
}

// ---------------------------------------------------------------------------------- hotkey

var hotKeyRef: EventHotKeyRef?

func parseHotkey(_ spec: String) -> (UInt32, UInt32)? {
    var mods: UInt32 = 0
    var code: UInt32?
    for part in spec.lowercased().split(separator: "+") {
        switch part {
        case "ctrl", "control": mods |= UInt32(controlKey)
        case "alt", "option", "opt": mods |= UInt32(optionKey)
        case "cmd", "command": mods |= UInt32(cmdKey)
        case "shift": mods |= UInt32(shiftKey)
        default: if let c = keyCodes[String(part)] { code = UInt32(c) }
        }
    }
    guard let c = code else { return nil }
    return (c, mods)
}

func registerHotkey(_ spec: String) -> Bool {
    guard let (code, mods) = parseHotkey(spec) else { return false }
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetEventDispatcherTarget(), { _, _, _ in
        DispatchQueue.main.async {
            emit(["event": "hotkey"])
            SpeechInput.shared.toggle()
        }
        return noErr
    }, 1, &eventType, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x5642_484B), id: 1)
    return RegisterEventHotKey(code, mods, id, GetEventDispatcherTarget(), 0, &hotKeyRef) == noErr
}

// ---------------------------------------------------------------------------------- commands

let cmdQueue = DispatchQueue(label: "vb.commands")
let bridge = AXBridge()

func handleOverlay(_ msg: [String: Any]) -> [String: Any] {
    let ms = (msg["ms"] as? Double) ?? 1800
    switch msg["fn"] as? String ?? "" {
    case "toast":
        let text = msg["text"] as? String ?? ""
        DispatchQueue.main.async { Overlay.shared.showToast(text, ms: ms) }
    case "highlight":
        guard let f = bridge.currentFrame(msg["ref"] as? String ?? "") else { return [:] }
        DispatchQueue.main.async { Overlay.shared.showHighlight(f, ms: ms) }
    case "candidates":
        var list: [(Int, CGRect)] = []
        for item in (msg["items"] as? [[String: Any]]) ?? [] {
            if let n = item["n"] as? Int, let f = bridge.currentFrame(item["ref"] as? String ?? "") { list.append((n, f)) }
        }
        DispatchQueue.main.async { Overlay.shared.showCandidates(list, ms: ms) }
    case "clearCandidates":
        DispatchQueue.main.async { Overlay.shared.clearCandidates() }
    default:
        return ["error": "unknown overlay function"]
    }
    return [:]
}

func handle(_ msg: [String: Any]) {
    let id = (msg["id"] as? Int) ?? 0
    var result: [String: Any]
    switch msg["cmd"] as? String ?? "" {
    case "snapshot": result = bridge.snapshot()
    case "click": result = bridge.click(msg["ref"] as? String ?? "")
    case "type": result = bridge.type(msg["ref"] as? String, text: msg["text"] as? String ?? "", submit: (msg["submit"] as? Bool) ?? false)
    case "key": result = bridge.key(msg["key"] as? String ?? "", mods: (msg["mods"] as? [String]) ?? [])
    case "shortcut":
        result = bridge.shortcut(msg["char"] as? String ?? "", shift: (msg["shift"] as? Bool) ?? false, alt: (msg["alt"] as? Bool) ?? false, ctrl: (msg["ctrl"] as? Bool) ?? false, fallback: msg["fallback"] as? String)
    case "scroll": result = bridge.scroll(down: (msg["down"] as? Bool) ?? true, amount: msg["amount"] as? String ?? "page")
    case "overlay": result = handleOverlay(msg)
    case "mic":
        let wanted = msg["on"] as? Bool
        DispatchQueue.main.async { if let w = wanted { SpeechInput.shared.set(w) } else { SpeechInput.shared.toggle() } }
        result = [:]
    case "hints":
        let words = (msg["words"] as? [String]) ?? []
        DispatchQueue.main.async { SpeechInput.shared.hints = words }
        result = [:]
    case "activate": result = bridge.activate(msg["name"] as? String ?? "")
    case "ping": result = ["axTrusted": AXIsProcessTrusted()]
    case "keys": result = bridge.keys((msg["keys"] as? [String]) ?? [], delayMs: (msg["delayMs"] as? Int) ?? 12)
    case "probe": result = bridge.probe()
    case "focus": result = bridge.focus()
    case "window": result = bridge.window(msg["op"] as? String ?? "")
    case "quit": result = bridge.quit(msg["name"] as? String)
    case "open_url": result = bridge.openURL(msg["url"] as? String ?? "", newTab: (msg["newTab"] as? Bool) ?? false)
    case "apps": result = bridge.apps((msg["dirs"] as? [String]) ?? [])
    case "lang":
        let locale = msg["locale"] as? String ?? ""
        // The speech state lives on the main thread; this queue is never the main thread, so waiting is safe.
        let err: String? = DispatchQueue.main.sync { MainActor.assumeIsolated { SpeechInput.shared.setLocale(locale) } }
        if let e = err { result = ["error": e] } else { emit(["event": "lang", "locale": locale]); result = ["locale": locale] }
    case "config":
        DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                let s = SpeechInput.shared
                if let w = msg["continuationWords"] as? [String] { s.continuationWords = Set(w.map { $0.lowercased() }) }
                if let w = msg["verbOnlyWords"] as? [String] { s.verbOnlyWords = Set(w.map { $0.lowercased() }) }
                if let v = msg["silenceShortMs"] as? Int, v > 0 { s.silenceShortMs = v }
                if let v = msg["silenceLongMs"] as? Int, v > 0 { s.silenceLongMs = v }
                if let v = msg["listening"] as? String, !v.isEmpty { Overlay.shared.listeningText = v }
                if let v = msg["micOff"] as? String, !v.isEmpty { Overlay.shared.micOffText = v }
            }
        }
        result = [:]
    default: result = ["error": "unknown command"]
    }
    if let e = result["error"] { emit(["id": id, "ok": false, "error": e]) } else { emit(["id": id, "ok": true, "result": result]) }
}

// ---------------------------------------------------------------------------------- main

var hotkeySpec = "ctrl+alt+w"
var localeArg = "en-US"
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--hotkey", let v = args.next() { hotkeySpec = v }
    if a == "--lang", let v = args.next() { localeArg = v }
}

// A process started from a terminal that turns into a windowed app is handed the focus. This one
// must stay in the background, so whoever was in front gets the focus back right after start-up.
let previousFront = NSWorkspace.shared.frontmostApplication
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
    guard NSApp.isActive, let prev = previousFront, prev.processIdentifier != getpid() else { return }
    NSApp.yieldActivation(to: prev)
    prev.activate()
}
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)

MainActor.assumeIsolated {
    SpeechInput.shared.localeId = localeArg
    Overlay.shared.start()
}
let hotkeyOK = registerHotkey(hotkeySpec)
// Asks for the Accessibility permission the first time (the prompt names the terminal app).
var axTrusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
emit(["event": "ready", "axTrusted": axTrusted, "hotkey": hotkeyOK, "hotkeySpec": hotkeySpec])

Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    let now = AXIsProcessTrusted()
    if now != axTrusted {
        axTrusted = now
        emit(["event": "ax", "trusted": now])
    }
}

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        cmdQueue.async { handle(msg) }
    }
    exit(0) // stdin closed: the Node server is gone
}

app.run()
