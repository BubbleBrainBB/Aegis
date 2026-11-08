import Foundation

@main
struct AegisSimHelper {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        do {
            switch arguments.first {
            case nil, "serve":
                Output.shared.claimStdout()
                await Server().run()
            case "probe":
                guard arguments.count >= 2 else { throw HelperError("usage: aegis-sim-helper probe <udid>") }
                try await Probe.run(udid: arguments[1])
            case "--version":
                print(Server.version)
            default:
                throw HelperError("usage: aegis-sim-helper [serve | probe <udid> | --version]")
            }
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(1)
        }
    }
}
