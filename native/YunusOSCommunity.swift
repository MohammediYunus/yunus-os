import Cocoa
import WebKit
import AVFoundation

// Optional local shell. Browser app owns setup, recording and explicit actions.
// This is not a global keyboard listener or an autonomous computer operator.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var speech = AVSpeechSynthesizer()
    let port = Int(ProcessInfo.processInfo.environment["YOS_PORT"] ?? "4173") ?? 4173
    var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "yunusSpeech")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Yunus OS Community"
        window.minSize = NSSize(width: 840, height: 620)
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        let main = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Yunus OS Community", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem(); item.submenu = appMenu; main.addItem(item)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)
        NSApp.mainMenu = main
        NSApp.activate(ignoringOtherApps: true)
        guard (1024...65535).contains(port) else { return showError("YOS_PORT must be between 1024 and 65535.") }
        checkHealth(startIfMissing: true, attempts: 0)
    }

    func findNode() -> URL? {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates = [String]()
        if let explicit = env["YOS_NODE"], !explicit.isEmpty { candidates.append(explicit) }
        for directory in (env["PATH"] ?? "").split(separator: ":") { candidates.append(String(directory) + "/node") }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node", home + "/.local/bin/node"]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    }

    func startServer() -> Bool {
        guard let node = findNode(), let resources = Bundle.main.resourceURL else {
            showError("Install Node.js 22 or newer, or launch with YOS_NODE set to its absolute path.")
            return false
        }
        let root = resources.appendingPathComponent("app", isDirectory: true)
        let process = Process()
        process.executableURL = node
        process.arguments = [root.appendingPathComponent("server.mjs").path]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["YOS_PORT"] = String(port)
        process.environment = env
        // App errors are presented by health diagnostics. Never persist prompts/logs here.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); server = process; return true }
        catch { showError("Could not launch the community server. Check Node.js and the app bundle."); return false }
    }

    func checkHealth(startIfMissing: Bool, attempts: Int) {
        var request = URLRequest(url: base.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let data = data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   object["app"] as? String == "yunus-os-community", object["ok"] as? Bool == true {
                    self.webView.load(URLRequest(url: self.base))
                    return
                }
                if response != nil && error == nil {
                    self.showError("Port \(self.port) belongs to another application. Set YOS_PORT to a free port and reopen.")
                    return
                }
                if startIfMissing && !self.startServer() { return }
                if attempts >= 24 || (self.server != nil && self.server?.isRunning == false) {
                    self.showError("The local server did not start. Use Node.js 22 or newer and check that the chosen port is free.")
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.checkHealth(startIfMissing: false, attempts: attempts + 1) }
            }
        }.resume()
    }

    func showError(_ text: String) {
        let alert = NSAlert()
        alert.messageText = "Yunus OS Community"
        alert.informativeText = text
        alert.alertStyle = .warning
        alert.runModal()
    }

    func ownOrigin(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if ownOrigin(navigationAction.request.url) { decisionHandler(.allow); return }
        // External links require a real click. Provider responses cannot navigate this shell.
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == "http" && origin.host == "127.0.0.1" && origin.port == port && type == .microphone ? .prompt : .deny)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, ownOrigin(message.frameInfo.request.url), let payload = message.body as? [String: Any] else { return }
        if payload["cancel"] as? Bool == true { speech.stopSpeaking(at: .immediate); return }
        guard let text = payload["text"] as? String, !text.isEmpty, text.count <= 16000 else { return }
        speech.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        speech.speak(utterance)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        speech.stopSpeaking(at: .immediate)
        if let server = server, server.isRunning { server.terminate() }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
