//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//

import SafariServices

/// The web extension never calls `browser.runtime.sendNativeMessage`, and its manifest does not
/// ask for `nativeMessaging`, so nothing is expected here. The handler answers with an empty
/// reply and logs nothing, so a future caller cannot leak wallet data into the system log.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }

}
