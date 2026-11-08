import FBSimulatorControl

/// US keyboard: a character to its HID usage and whether it needs Shift.
/// Text outside this set goes through the simulator's pasteboard instead.
enum Keyboard {
    static let shift: UInt32 = 225

    static func usage(for character: Character) -> (code: UInt32, shift: Bool)? {
        guard let scalar = character.unicodeScalars.first, character.unicodeScalars.count == 1, scalar.isASCII else {
            return nil
        }
        let value = scalar.value
        switch value {
        case 0x61...0x7a: return (4 + value - 0x61, false) // a-z
        case 0x41...0x5a: return (4 + value - 0x41, true) // A-Z
        case 0x31...0x39: return (30 + value - 0x31, false) // 1-9
        case 0x30: return (39, false) // 0
        default: break
        }
        let table: [Character: (UInt32, Bool)] = [
            "\n": (40, false), "\t": (43, false), " ": (44, false),
            "-": (45, false), "_": (45, true), "=": (46, false), "+": (46, true),
            "[": (47, false), "{": (47, true), "]": (48, false), "}": (48, true),
            "\\": (49, false), "|": (49, true), ";": (51, false), ":": (51, true),
            "'": (52, false), "\"": (52, true), "`": (53, false), "~": (53, true),
            ",": (54, false), "<": (54, true), ".": (55, false), ">": (55, true),
            "/": (56, false), "?": (56, true),
            "!": (30, true), "@": (31, true), "#": (32, true), "$": (33, true), "%": (34, true),
            "^": (35, true), "&": (36, true), "*": (37, true), "(": (38, true), ")": (39, true),
        ]
        return table[character].map { (code: $0.0, shift: $0.1) }
    }

    /// Key presses for text, or nil when some character has no key.
    static func events(for text: String) -> [FBSimulatorHIDEvent]? {
        var events: [FBSimulatorHIDEvent] = []
        for character in text {
            guard let key = usage(for: character) else { return nil }
            if key.shift { events.append(.keyboard(direction: .down, keyCode: shift)) }
            events.append(.keyboard(direction: .down, keyCode: key.code))
            events.append(.keyboard(direction: .up, keyCode: key.code))
            if key.shift { events.append(.keyboard(direction: .up, keyCode: shift)) }
        }
        return events
    }
}
