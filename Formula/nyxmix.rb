require "language/node"

class Nyxmix < Formula
  desc "Browser-based multitrack audio editor with an MCP server"
  homepage "https://github.com/Open-Cosmic-Software/nyxmix"
  url "https://registry.npmjs.org/nyxmix/-/nyxmix-0.1.0.tgz"
  sha256 "8f7bc87302c516abbd4f05a9117ce4f02f47b26796cac3b40c753477889987b8"
  license "MIT"

  depends_on "ffmpeg-full"
  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    (bin/"nyxmix").write_env_script libexec/"bin/nyxmix",
      PATH: "#{Formula["ffmpeg-full"].opt_bin}:#{Formula["node"].opt_bin}:$PATH"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/nyxmix --version").strip
  end
end
