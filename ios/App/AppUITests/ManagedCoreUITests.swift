import XCTest

final class ManagedCoreUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testManagedCoreJourney() throws {
        let app = XCUIApplication()
        app.launchArguments.append("--geode-ios-mvp-acceptance-seed")
        app.launchEnvironment["GEODE_IOS_MVP_ACCEPTANCE"] = "seed"
        app.launch()

        let verifier = app.staticTexts["Native managed-core verifier"]
        XCTAssertTrue(
            verifier.waitForExistence(timeout: 10),
            "The DEBUG native verifier must expose the active adapter and managed-vault snapshot"
        )
        let snapshot = try waitForReadySnapshot(from: verifier, rootEntries: ["Welcome.md"])
        XCTAssertEqual(snapshot["adapter"] as? String, "capacitor-managed-vault")
        XCTAssertEqual(snapshot["vault"] as? String, "managed://default")
        XCTAssertEqual(snapshot["rootEntries"] as? [String], ["Welcome.md"])
        XCTAssertEqual(snapshot["trashExists"] as? Bool, true)
        XCTAssertEqual(snapshot["trashNonempty"] as? Bool, true)
        XCTAssertEqual(snapshot["listedTrash"] as? Bool, false)
        let legacyTrash = try XCTUnwrap(snapshot["trashRecords"] as? [[String: String]])
        XCTAssertEqual(legacyTrash.count, 1)
        XCTAssertEqual(legacyTrash[0]["id"], "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(legacyTrash[0]["payload"], "discarded fixture bytes")
        XCTAssertEqual(legacyTrash[0]["metadata"], "{\"originalPath\":\"Discarded.md\"}")
        XCTAssertEqual(snapshot["nativeErrors"] as? [String], [])
        let javascript = try XCTUnwrap(snapshot["javascript"] as? [String: Any])
        XCTAssertEqual(javascript["ready"] as? Bool, true)
        XCTAssertEqual(javascript["runtime"] as? String, "ios")
        XCTAssertNil(javascript["snapshotError"])
        XCTAssertEqual(javascript["errors"] as? [[String: String]], [])
        waitForPaintedShell(in: app)

        let safeAreaTop = try XCTUnwrap(snapshot["safeAreaTop"] as? Double)
        XCTAssertGreaterThan(safeAreaTop, 0)
        let filesButton = app.buttons["Files"]
        XCTAssertTrue(filesButton.isHittable)
        try openFilesDrawer(in: app, verifier: verifier)

        XCTAssertFalse(app.staticTexts["Vault"].exists)
        XCTAssertFalse(app.staticTexts[".geode-trash"].exists)

        let welcome = app.buttons["Open file Welcome.md"]
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        waitUntilHittable(welcome)
        XCTAssertLessThanOrEqual(welcome.frame.maxX, app.windows.firstMatch.frame.maxX)
        XCTAssertLessThanOrEqual(welcome.frame.width, app.windows.firstMatch.frame.width)
        XCTAssertGreaterThanOrEqual(welcome.frame.minY, safeAreaTop)
        _ = try tapUntilSnapshot(
            welcome,
            verifier: verifier,
            description: "Welcome did not become active"
        ) {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Welcome.md"
        }
        assertKeyboardRemainsAbsent(in: app, after: "opening Welcome from Files")
        let postOpenJavaScript = try XCTUnwrap(
            (try readSnapshot(from: verifier))["javascript"] as? [String: Any]
        )
        XCTAssertEqual(postOpenJavaScript["leftDrawerOpen"] as? Bool, false)
        XCTAssertEqual(
            postOpenJavaScript["activeElementInClosedDrawer"] as? Bool,
            false,
            "Closing Files after activation must not leave focus pinned to an offscreen file row"
        )
        XCTAssertEqual(postOpenJavaScript["mobileNavigationInert"] as? Bool, false)
        XCTAssertEqual(postOpenJavaScript["mobileNavigationHitTarget"] as? String, "New note")
        for label in ["Files", "Search", "New note", "Details", "More"] {
            waitUntilHittable(mobileNavigationButton(label, in: app))
        }
        assertStableMobileNavigation(in: app)

        let editor = app.textViews["Note editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue(editor.isHittable)
        XCTAssertGreaterThanOrEqual(editor.frame.minY, safeAreaTop)
        attachScreenshot(named: "01-welcome-open")

        let welcomeInsertion = "# Edited through native XCUI\n\nPersisted managed bytes"
        _ = try tapUntilSnapshot(
            editor,
            verifier: verifier,
            description: "One explicit editor tap did not move DOM focus into CodeMirror"
        ) { snapshot in
            (snapshot["javascript"] as? [String: Any])?["editorFocused"] as? Bool == true
        }
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 3),
            "One explicit editor tap must summon the software keyboard"
        )
        editor.typeText(welcomeInsertion)
        let editedSnapshot = try waitForSnapshot(
            from: verifier,
            description: "Welcome edit did not persist"
        ) { snapshot in
            (snapshot["bytes"] as? [String: String])?["Welcome.md"]?.contains(welcomeInsertion) == true
        }
        let editedBytes = try XCTUnwrap(editedSnapshot["bytes"] as? [String: String])
        let editedWelcome = try XCTUnwrap(editedBytes["Welcome.md"])
        let editedJavaScript = try XCTUnwrap(editedSnapshot["javascript"] as? [String: Any])
        XCTAssertEqual(editedBytes["Welcome.md"], editedWelcome)
        XCTAssertEqual(editedJavaScript["editor"] as? String, editedWelcome)

        XCTAssertTrue(app.keyboards.firstMatch.exists)
        dismissKeyboard(in: app, with: editor)
        let newNoteButton = try XCTUnwrap(
            app.buttons.matching(identifier: "New note").allElementsBoundByIndex.first(where: \.isHittable),
            "New note remained covered after on-drag keyboard dismissal"
        )
        _ = try tapUntilSnapshot(
            newNoteButton,
            verifier: verifier,
            description: "New note action did not create and activate an untitled note"
        ) { snapshot in
            ((snapshot["javascript"] as? [String: Any])?["activeFile"] as? String)?.hasPrefix("Untitled") == true
        }
        let title = app.textFields["Note title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(title.isHittable)
        title.typeText("Native Journey")
        title.typeText("\n")

        _ = try waitForSnapshot(from: verifier, description: "New note title did not commit") {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Native Journey.md"
        }
        let newEditor = app.textViews["Note editor"]
        XCTAssertTrue(newEditor.waitForExistence(timeout: 5))
        _ = try tapUntilSnapshot(
            newEditor,
            verifier: verifier,
            description: "New note editor did not receive DOM focus"
        ) { snapshot in
            (snapshot["javascript"] as? [String: Any])?["editorFocused"] as? Bool == true
        }

        let newBody = "Created and persisted through native XCUI"
        newEditor.typeText(newBody)
        _ = try waitForSnapshot(from: verifier, description: "New note body did not persist") {
            ($0["bytes"] as? [String: String])?["Native Journey.md"] == newBody
        }
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let keyboardSnapshot = try readSnapshot(from: verifier)
        let keyboardJavaScript = try XCTUnwrap(keyboardSnapshot["javascript"] as? [String: Any])
        try assertRemainsAboveSafeArea(
            verifier: verifier,
            in: app,
            safeAreaTop: safeAreaTop,
            diagnostics: keyboardJavaScript
        )
        attachScreenshot(named: "02-new-note-keyboard-safe-area")
        let createdSnapshot = try readSnapshot(from: verifier)
        XCTAssertEqual(createdSnapshot["rootEntries"] as? [String], ["Native Journey.md", "Welcome.md"])
        let createdBytes = try XCTUnwrap(createdSnapshot["bytes"] as? [String: String])
        XCTAssertEqual(createdBytes["Welcome.md"], editedWelcome)
        XCTAssertEqual(createdBytes["Native Journey.md"], newBody)

        app.terminate()
        app.launchArguments = ["--geode-ios-mvp-acceptance-verify"]
        app.launchEnvironment = ["GEODE_IOS_MVP_ACCEPTANCE": "verify"]
        app.launch()

        let relaunchedVerifier = app.staticTexts["Native managed-core verifier"]
        XCTAssertTrue(relaunchedVerifier.waitForExistence(timeout: 10))
        let relaunchedSnapshot = try waitForReadySnapshot(
            from: relaunchedVerifier,
            rootEntries: ["Native Journey.md", "Welcome.md"]
        )
        XCTAssertEqual(relaunchedSnapshot["mode"] as? String, "verify")
        XCTAssertEqual(relaunchedSnapshot["adapter"] as? String, "capacitor-managed-vault")
        XCTAssertEqual(relaunchedSnapshot["vault"] as? String, "managed://default")
        XCTAssertEqual(relaunchedSnapshot["rootEntries"] as? [String], ["Native Journey.md", "Welcome.md"])
        XCTAssertEqual(relaunchedSnapshot["trashExists"] as? Bool, true)
        XCTAssertEqual(relaunchedSnapshot["trashNonempty"] as? Bool, true)
        XCTAssertEqual(relaunchedSnapshot["listedTrash"] as? Bool, false)
        let relaunchedBytes = try XCTUnwrap(relaunchedSnapshot["bytes"] as? [String: String])
        XCTAssertEqual(relaunchedBytes["Welcome.md"], editedWelcome)
        XCTAssertEqual(relaunchedBytes["Native Journey.md"], newBody)
        XCTAssertEqual(relaunchedSnapshot["nativeErrors"] as? [String], [])
        let relaunchedJavaScript = try XCTUnwrap(relaunchedSnapshot["javascript"] as? [String: Any])
        XCTAssertEqual(relaunchedJavaScript["ready"] as? Bool, true)
        XCTAssertEqual(relaunchedJavaScript["runtime"] as? String, "ios")
        XCTAssertNil(relaunchedJavaScript["snapshotError"])
        XCTAssertEqual(relaunchedJavaScript["errors"] as? [[String: String]], [])
        waitForPaintedShell(in: app)
        assertKeyboardRemainsAbsent(in: app, after: "cold relaunch")
        attachScreenshot(named: "03-cold-relaunch")

        try openFilesDrawer(in: app, verifier: relaunchedVerifier)
        let relaunchedWelcome = app.buttons["Open file Welcome.md"]
        XCTAssertTrue(relaunchedWelcome.waitForExistence(timeout: 5))
        waitUntilHittable(relaunchedWelcome)
        XCTAssertLessThanOrEqual(relaunchedWelcome.frame.maxX, app.windows.firstMatch.frame.maxX)
        XCTAssertLessThanOrEqual(relaunchedWelcome.frame.width, app.windows.firstMatch.frame.width)
        _ = try tapUntilSnapshot(
            relaunchedWelcome,
            verifier: relaunchedVerifier,
            description: "Welcome did not reopen"
        ) {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Welcome.md"
                && ($0["bytes"] as? [String: String])?["Welcome.md"] == editedWelcome
        }
        assertKeyboardRemainsAbsent(in: app, after: "reopening Welcome from Files")

        try openFilesDrawer(in: app, verifier: relaunchedVerifier)
        let relaunchedJourney = app.buttons["Open file Native Journey.md"]
        XCTAssertTrue(relaunchedJourney.waitForExistence(timeout: 5))
        waitUntilHittable(relaunchedJourney)
        XCTAssertLessThanOrEqual(relaunchedJourney.frame.maxX, app.windows.firstMatch.frame.maxX)
        XCTAssertLessThanOrEqual(relaunchedJourney.frame.width, app.windows.firstMatch.frame.width)
        _ = try tapUntilSnapshot(
            relaunchedJourney,
            verifier: relaunchedVerifier,
            description: "Native Journey did not reopen"
        ) {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Native Journey.md"
                && ($0["bytes"] as? [String: String])?["Native Journey.md"] == newBody
        }
        assertKeyboardRemainsAbsent(in: app, after: "reopening Native Journey from Files")

        let relaunchedSafeTop = try XCTUnwrap(relaunchedSnapshot["safeAreaTop"] as? Double)
        let relaunchedSafeBottom = try XCTUnwrap(relaunchedSnapshot["safeAreaBottom"] as? Double)
        let moreButton = app.buttons["More"]
        XCTAssertTrue(moreButton.isHittable)
        XCTAssertLessThanOrEqual(
            moreButton.frame.maxY,
            app.windows.firstMatch.frame.maxY - relaunchedSafeBottom,
            "Mobile navigation entered the native home-indicator safe area"
        )
        _ = try tapUntilSnapshot(
            app.buttons["Details"],
            verifier: relaunchedVerifier,
            description: "Details action did not open its modal drawer"
        ) {
            ($0["javascript"] as? [String: Any])?["mobileNavigationInert"] as? Bool == true
        }
        let closeDetails = app.buttons["Close details drawer"]
        XCTAssertTrue(closeDetails.waitForExistence(timeout: 5))
        XCTAssertTrue(closeDetails.isHittable)
        XCTAssertFalse(app.staticTexts["Close details drawer"].exists)
        let detailsSnapshot = try readSnapshot(from: relaunchedVerifier)
        let rightDrawerTop = try XCTUnwrap(
            (detailsSnapshot["javascript"] as? [String: Any])?["rightDrawerTop"] as? Double
        )
        XCTAssertGreaterThanOrEqual(rightDrawerTop, relaunchedSafeTop)
        // The drawer is modal, so the five navigation actions intentionally
        // become inert rather than hittable. They remain visually rendered;
        // wait past the CSS transition and prove their layout before capture.
        // Inert descendants are intentionally excluded from elementFromPoint.
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        let settledDetailsSnapshot = try readSnapshot(from: relaunchedVerifier)
        let settledDetailsJavaScript = try XCTUnwrap(
            settledDetailsSnapshot["javascript"] as? [String: Any]
        )
        XCTAssertEqual(settledDetailsJavaScript["mobileNavigationInert"] as? Bool, true)
        let settledNavigation = try XCTUnwrap(
            settledDetailsJavaScript["mobileNavigationLayout"] as? [String: Any]
        )
        XCTAssertEqual(
            settledNavigation["labels"] as? [String],
            ["Files", "Search", "New note", "Details", "More"]
        )
        XCTAssertEqual(settledNavigation["allVisible"] as? Bool, true)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(settledNavigation["minLeft"] as? Double), 0)
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(settledNavigation["maxRight"] as? Double),
            app.windows.firstMatch.frame.width
        )
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(settledNavigation["minHeight"] as? Double), 44)
        attachScreenshot(named: "04-details")
        _ = try tapUntilSnapshot(
            closeDetails,
            verifier: relaunchedVerifier,
            description: "Details drawer did not close"
        ) {
            ($0["javascript"] as? [String: Any])?["mobileNavigationInert"] as? Bool == false
        }

        let settings = app.buttons["Settings"]
        tapUntilExists(app.buttons["More"], target: settings, description: "More menu did not open")
        XCTAssertTrue(settings.isHittable)
        let appearanceTab = app.buttons["Appearance"]
        tapUntilExists(settings, target: appearanceTab, description: "Settings did not open")
        XCTAssertTrue(appearanceTab.isHittable)
        let darkMode = app.switches["Dark mode"]
        XCTAssertTrue(darkMode.isHittable)
        let settingsSnapshot = try readSnapshot(from: relaunchedVerifier)
        let settingsRect = try XCTUnwrap(
            (settingsSnapshot["javascript"] as? [String: Any])?["settingsRect"] as? [String: Any]
        )
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(settingsRect["top"] as? Double), relaunchedSafeTop)
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(settingsRect["bottom"] as? Double),
            app.windows.firstMatch.frame.maxY - relaunchedSafeBottom
        )
        attachScreenshot(named: "05-settings")
        let closeSettings = app.buttons["Close Settings"]
        XCTAssertTrue(closeSettings.isHittable)
        XCTAssertGreaterThanOrEqual(closeSettings.frame.height, 44)
        tapUntilGone(closeSettings, target: appearanceTab, description: "Settings did not close")
        XCTAssertTrue(app.buttons["More"].isHittable)
    }

    private func assertKeyboardRemainsAbsent(
        in app: XCUIApplication,
        after action: String
    ) {
        for _ in 0..<5 {
            XCTAssertFalse(app.keyboards.firstMatch.exists, "Keyboard appeared without an editor tap after \(action)")
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
    }

    private func assertRemainsAboveSafeArea(
        verifier: XCUIElement,
        in app: XCUIApplication,
        safeAreaTop: Double,
        diagnostics: [String: Any]
    ) throws {
        var observedVisibleTops: [Double] = []
        for _ in 0..<8 {
            XCTAssertTrue(app.keyboards.firstMatch.exists, "Keyboard disappeared during the safe-area stability window")
            let snapshot = try readSnapshot(from: verifier)
            let javascript = try XCTUnwrap(snapshot["javascript"] as? [String: Any])
            let headerTop = try XCTUnwrap(javascript["activeHeaderTop"] as? Double)
            let viewportTop = try XCTUnwrap(javascript["visualViewportTop"] as? Double)
            let visibleTop = headerTop - viewportTop
            observedVisibleTops.append(visibleTop)
            XCTAssertGreaterThanOrEqual(
                visibleTop,
                safeAreaTop,
                "Header entered the status-bar safe area while the keyboard remained visible. Visible tops: \(observedVisibleTops); current diagnostics: \(javascript); initial diagnostics: \(diagnostics)"
            )
            RunLoop.current.run(until: Date().addingTimeInterval(0.125))
        }
    }

    private func assertStableMobileNavigation(in app: XCUIApplication) {
        let labels = ["Files", "Search", "New note", "Details", "More"]
        for _ in 0..<5 {
            for label in labels {
                let button = mobileNavigationButton(label, in: app)
                XCTAssertTrue(button.exists, "Mobile navigation action disappeared: \(label)")
                XCTAssertTrue(button.isHittable, "Mobile navigation action became unhittable: \(label)")
                XCTAssertGreaterThanOrEqual(button.frame.width, 44)
                XCTAssertGreaterThanOrEqual(button.frame.height, 44)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
    }

    private func mobileNavigationButton(_ label: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: label).allElementsBoundByIndex.max {
            $0.frame.minY < $1.frame.minY
        } ?? app.buttons[label]
    }

    func testLegacyManagedWrapperMigratesBeforeActivation() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--geode-ios-mvp-acceptance-legacy"]
        app.launchEnvironment = ["GEODE_IOS_MVP_ACCEPTANCE": "legacy"]
        app.launch()

        let verifier = app.staticTexts["Native managed-core verifier"]
        XCTAssertTrue(verifier.waitForExistence(timeout: 15))
        let snapshot = try waitForReadySnapshot(
            from: verifier,
            rootEntries: ["Untitled.md", "Welcome.md"]
        )
        XCTAssertEqual(snapshot["adapter"] as? String, "capacitor-managed-vault")
        XCTAssertEqual(snapshot["vault"] as? String, "managed://default")
        XCTAssertEqual(snapshot["rootEntries"] as? [String], ["Untitled.md", "Welcome.md"])
        XCTAssertEqual(snapshot["entries"] as? [String], ["Untitled.md", "Welcome.md"])
        let bytes = try XCTUnwrap(snapshot["bytes"] as? [String: String])
        XCTAssertEqual(bytes["Untitled.md"], "Preexisting root note")
        XCTAssertEqual(bytes["Welcome.md"], "# Welcome to Geode Mobile\n")
        XCTAssertEqual(snapshot["listedTrash"] as? Bool, false)
        XCTAssertEqual(snapshot["trashNonempty"] as? Bool, true)
        let migratedTrash = try XCTUnwrap(snapshot["trashRecords"] as? [[String: String]])
        XCTAssertEqual(migratedTrash.count, 1)
        XCTAssertEqual(migratedTrash[0]["id"], "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(migratedTrash[0]["payload"], "discarded fixture bytes")
        XCTAssertEqual(migratedTrash[0]["metadata"], "{\"originalPath\":\"Discarded.md\"}")
        XCTAssertEqual(snapshot["legacyWrapperExists"] as? Bool, false)
        XCTAssertEqual(snapshot["legacyBackupCount"] as? Int, 1)
        XCTAssertEqual(snapshot["legacyMigrationCompleted"] as? Bool, true)
        waitForPaintedShell(in: app)
        XCTAssertFalse(app.staticTexts["Vault"].exists)
        XCTAssertFalse(app.staticTexts[".geode-trash"].exists)

        let files = app.buttons["Files"]
        XCTAssertTrue(files.isHittable)
        try openFilesDrawer(in: app, verifier: verifier)
        let welcome = app.buttons["Open file Welcome.md"]
        XCTAssertTrue(welcome.waitForExistence(timeout: 5))
        waitUntilHittable(welcome)
        XCTAssertLessThanOrEqual(welcome.frame.maxX, app.windows.firstMatch.frame.maxX)
        XCTAssertLessThanOrEqual(welcome.frame.width, app.windows.firstMatch.frame.width)
        _ = try tapUntilSnapshot(
            welcome,
            verifier: verifier,
            description: "Migrated Welcome did not open"
        ) {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Welcome.md"
        }
        XCTAssertFalse(app.staticTexts["Vault"].exists)
        XCTAssertFalse(app.staticTexts[".geode-trash"].exists)
        attachScreenshot(named: "legacy-01-migrated-root-welcome-open")

        let newNoteButton = try XCTUnwrap(
            app.buttons.matching(identifier: "New note").allElementsBoundByIndex.first(where: \.isHittable),
            "No hittable New note action remained after opening the migrated Welcome note"
        )
        _ = try tapUntilSnapshot(
            newNoteButton,
            verifier: verifier,
            description: "New note action did not create and activate an untitled note"
        ) { snapshot in
            guard let activeFile = (snapshot["javascript"] as? [String: Any])?["activeFile"] as? String else {
                return false
            }
            return activeFile.hasPrefix("Untitled") && activeFile != "Untitled.md"
        }
        let title = app.textFields["Note title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.typeText("Legacy Journey")
        title.typeText("\n")
        _ = try waitForSnapshot(from: verifier, description: "Legacy Journey title did not commit") {
            ($0["javascript"] as? [String: Any])?["activeFile"] as? String == "Legacy Journey.md"
        }
        let editor = app.textViews["Note editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue(editor.isHittable)
        _ = try tapUntilSnapshot(
            editor,
            verifier: verifier,
            description: "Legacy journey editor did not receive DOM focus"
        ) { snapshot in
            (snapshot["javascript"] as? [String: Any])?["editorFocused"] as? Bool == true
        }
        let body = "Created after collision-safe migration"
        editor.typeText(body)
        let created = try waitForSnapshot(from: verifier, description: "Legacy Journey did not persist") {
            ($0["bytes"] as? [String: String])?["Legacy Journey.md"] == body
        }
        XCTAssertEqual(created["rootEntries"] as? [String], ["Legacy Journey.md", "Untitled.md", "Welcome.md"])

        app.terminate()
        app.launchArguments = ["--geode-ios-mvp-acceptance-verify"]
        app.launchEnvironment = ["GEODE_IOS_MVP_ACCEPTANCE": "verify"]
        app.launch()
        let relaunchedVerifier = app.staticTexts["Native managed-core verifier"]
        XCTAssertTrue(relaunchedVerifier.waitForExistence(timeout: 15))
        let relaunched = try waitForReadySnapshot(
            from: relaunchedVerifier,
            rootEntries: ["Legacy Journey.md", "Untitled.md", "Welcome.md"]
        )
        waitForPaintedShell(in: app)
        XCTAssertEqual(relaunched["rootEntries"] as? [String], ["Legacy Journey.md", "Untitled.md", "Welcome.md"])
        XCTAssertEqual((relaunched["bytes"] as? [String: String])?["Legacy Journey.md"], body)
        XCTAssertEqual(relaunched["legacyWrapperExists"] as? Bool, false)
        XCTAssertEqual(relaunched["legacyBackupCount"] as? Int, 1)
        XCTAssertEqual(relaunched["legacyMigrationCompleted"] as? Bool, true)
    }

    private func readSnapshot(from verifier: XCUIElement) throws -> [String: Any] {
        let value = try XCTUnwrap(verifier.value as? String)
        let data = try XCTUnwrap(value.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func waitForReadySnapshot(
        from verifier: XCUIElement,
        rootEntries: [String],
        timeout: TimeInterval = 30
    ) throws -> [String: Any] {
        let ready = expectation(
            for: NSPredicate { object, _ in
                guard
                    let element = object as? XCUIElement,
                    let value = element.value as? String,
                    let data = value.data(using: .utf8),
                    let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let javascript = snapshot["javascript"] as? [String: Any]
                else { return false }
                return snapshot["adapter"] as? String == "capacitor-managed-vault"
                    && snapshot["vault"] as? String == "managed://default"
                    && snapshot["rootEntries"] as? [String] == rootEntries
                    && javascript["ready"] as? Bool == true
                    && javascript["runtime"] as? String == "ios"
            },
            evaluatedWith: verifier
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [ready], timeout: timeout),
            .completed,
            "Native verifier did not reach the expected adapter, vault, root, and renderer state. Last snapshot: \(String(describing: verifier.value))"
        )
        return try readSnapshot(from: verifier)
    }

    private func waitForSnapshot(
        from verifier: XCUIElement,
        timeout: TimeInterval = 10,
        description: String,
        matching: @escaping ([String: Any]) -> Bool
    ) throws -> [String: Any] {
        let matched = expectation(
            for: NSPredicate { object, _ in
                guard
                    let element = object as? XCUIElement,
                    let value = element.value as? String,
                    let data = value.data(using: .utf8),
                    let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return false }
                return matching(snapshot)
            },
            evaluatedWith: verifier
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [matched], timeout: timeout),
            .completed,
            "\(description). Last snapshot: \(String(describing: verifier.value))"
        )
        return try readSnapshot(from: verifier)
    }

    private func tapUntilSnapshot(
        _ element: XCUIElement,
        verifier: XCUIElement,
        timeout: TimeInterval = 10,
        description: String,
        matching: ([String: Any]) -> Bool
    ) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var attempts = 0
        var snapshot = try readSnapshot(from: verifier)

        while !matching(snapshot), attempts < 3, Date() < deadline {
            waitUntilHittable(element, timeout: min(5, deadline.timeIntervalSinceNow))
            element.tap()
            attempts += 1

            let attemptDeadline = min(deadline, Date().addingTimeInterval(2))
            repeat {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                snapshot = try readSnapshot(from: verifier)
                if matching(snapshot) { return snapshot }
            } while Date() < attemptDeadline
        }

        XCTAssertTrue(
            matching(snapshot),
            "\(description) after \(attempts) bounded tap attempts. Last snapshot: \(snapshot)"
        )
        return snapshot
    }

    private func tapUntilExists(
        _ element: XCUIElement,
        target: XCUIElement,
        description: String
    ) {
        for attempt in 1...3 {
            if target.exists { return }
            waitUntilHittable(element)
            element.tap()
            if target.waitForExistence(timeout: 2) { return }
            if attempt == 3 { XCTFail("\(description) after 3 bounded tap attempts") }
        }
    }

    private func tapUntilGone(
        _ element: XCUIElement,
        target: XCUIElement,
        description: String
    ) {
        for attempt in 1...3 {
            if !target.exists { return }
            waitUntilHittable(element)
            element.tap()
            let deadline = Date().addingTimeInterval(2)
            while target.exists, Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
            if !target.exists { return }
            if attempt == 3 { XCTFail("\(description) after 3 bounded tap attempts") }
        }
    }

    private func dismissKeyboard(in app: XCUIApplication, with editor: XCUIElement) {
        for attempt in 1...3 {
            if !app.keyboards.firstMatch.exists { return }
            editor.swipeDown()
            let deadline = Date().addingTimeInterval(2)
            while app.keyboards.firstMatch.exists, Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
            if !app.keyboards.firstMatch.exists { return }
            if attempt == 3 { XCTFail("Keyboard did not dismiss after 3 bounded downward swipes") }
        }
    }

    private func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval = 5) {
        let hittable = expectation(
            for: NSPredicate(format: "hittable == true"),
            evaluatedWith: element
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [hittable], timeout: timeout),
            .completed,
            "Element never became hittable: \(element.debugDescription)"
        )
    }

    private func waitForPaintedShell(in app: XCUIApplication) {
        let windowFrame = app.windows.firstMatch.frame
        for label in ["Files", "Search", "New note", "Details", "More"] {
            let button = mobileNavigationButton(label, in: app)
            waitUntilHittable(button, timeout: 15)
            XCTAssertGreaterThanOrEqual(button.frame.width, 44)
            XCTAssertGreaterThanOrEqual(button.frame.height, 44)
            XCTAssertGreaterThanOrEqual(button.frame.minX, windowFrame.minX)
            XCTAssertLessThanOrEqual(button.frame.maxX, windowFrame.maxX)
            XCTAssertLessThanOrEqual(button.frame.maxY, windowFrame.maxY)
        }
    }

    private func openFilesDrawer(in app: XCUIApplication, verifier: XCUIElement) throws {
        _ = try tapUntilSnapshot(
            mobileNavigationButton("Files", in: app),
            verifier: verifier,
            description: "Files did not open the drawer"
        ) {
            ($0["javascript"] as? [String: Any])?["leftDrawerOpen"] as? Bool == true
        }
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
