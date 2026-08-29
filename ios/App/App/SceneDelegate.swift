import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = GeodeBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
#if DEBUG
        print("GEODE_NATIVE_LIFECYCLE background")
#endif
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
#if DEBUG
        print("GEODE_NATIVE_LIFECYCLE foreground")
#endif
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
#if DEBUG
        print("GEODE_NATIVE_LIFECYCLE active")
#endif
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        (window?.rootViewController as? GeodeBridgeViewController)?.releaseVaultAccess()
    }
}
