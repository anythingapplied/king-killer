{ pkgs, ... }: {
  # https://devenv.sh/basics/
  languages.rust.enable = true;
  languages.javascript = {
    enable = true;
    npm.enable = true;
  };

  # https://devenv.sh/packages/
  packages = [
    pkgs.sqlite
    pkgs.sqlx-cli
    pkgs.pkg-config
    pkgs.openssl
    pkgs.gcc
    pkgs.playwright-driver.browsers
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
    # Dynamically find the chromium path provided by nixpkgs
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = "${pkgs.playwright-driver.browsers}/chromium-1208/chrome-linux64/chrome";
  };

  # https://devenv.sh/scripts/
  scripts.hello.exec = "echo Welcome to the King Killer development environment!";

  enterShell = ''
    hello
  '';

  # https://devenv.sh/pre-commit-hooks/
  # pre-commit.hooks.shellcheck.enable = true;

  # https://devenv.sh/processes/
  # processes.ping.exec = "ping localhost";
}
