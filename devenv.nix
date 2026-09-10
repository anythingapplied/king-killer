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
    pkgs.flyctl
    pkgs.playwright-driver.browsers
  ];

  env = {
    PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
  };

  # https://devenv.sh/scripts/
  scripts.hello.exec = "echo Welcome to the King Killer development environment!";

  enterShell = ''
    hello
    # The chromium revision in the nixpkgs playwright driver bumps over time, so
    # resolve it dynamically instead of hardcoding a version number.
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(echo ${pkgs.playwright-driver.browsers}/chromium-*/chrome-linux64/chrome | awk '{print $1}')"
  '';

  # https://devenv.sh/pre-commit-hooks/
  # pre-commit.hooks.shellcheck.enable = true;

  # https://devenv.sh/processes/
  # processes.ping.exec = "ping localhost";
}
