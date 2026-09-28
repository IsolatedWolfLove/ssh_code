# Changelog

## 1.0.1

- Isolate SSH Agent tests from the runner environment on macOS.
- Use native local-path expectations in SSH configuration tests on Windows.
- Report Go test failures in GitHub Actions annotations for easier diagnosis.

## 1.0.0

- Switch the default desktop runtime from Electron to Go and Wails; retain the React/TypeScript interface.
- Complete SSH/SFTP, terminal, transfers, tunnels, language-server and remote video integration.
- Add Go integration and race tests plus frontend bridge regression checks.
- Replace release automation with native Linux, macOS and Windows builds, version validation, restricted publishing permissions and SHA-256 checksums.
- Require Go 1.26.6 to include standard-library security fixes.
- Update npm dependencies to address the known vulnerabilities reported during release preparation.

Packages are not code-signed or notarized. Legacy Electron sources remain for regression coverage and optional development.
