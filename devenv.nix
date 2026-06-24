{ pkgs, lib, config, inputs, ... }:

{
  # https://devenv.sh/languages/
  # Node.js 24 を固定（package.json engines: ">=24" / CI: setup-node@24 と一致）。
  # pnpm のバージョンは corepack 経由で package.json の
  # "packageManager": "pnpm@10.33.0" を尊重する。
  # → devenv と package.json でバージョンを二重管理しなくて済み、
  #   CI（pnpm/action-setup が packageManager から解決）とも挙動が揃う。
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
  };

  # https://devenv.sh/packages/
  # AWS CLI v2 — CDK デプロイや `aws s3 sync` をローカルで完結させる。
  packages = [
    pkgs.awscli2
  ];

  # https://devenv.sh/integrations/dotenv/
  # .env があれば自動で読み込む（.env.example を .env にコピーして使う）。
  # .env は .gitignore 済みなのでシークレットがコミットされる心配はない。
  dotenv.enable = true;

  # https://devenv.sh/basics/
  enterShell = ''
    echo "🎬 stagecast devenv ready"
    echo "  Node $(node -v) / pnpm $(pnpm -v 2>/dev/null || echo '(初回は corepack が自動取得)')"
    echo "  $(aws --version 2>&1)"
  '';

  # See full reference at https://devenv.sh/reference/options/
}
