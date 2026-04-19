import argparse
import os
import posixpath
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import paramiko


DEFAULT_FILES = [
    "index.html",
    "没命了.html",
    "logo.png",
    "card-swipe.jpg",
    "server.js",
    "package.json",
    "package-lock.json",
    "ecosystem.config.cjs",
    ".gitignore",
    "阿里云部署说明.md",
]


def read_server_file(server_file: Path):
    lines = [line.strip() for line in server_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) < 3:
        raise ValueError(f"服务器信息文件格式错误: {server_file}")
    return lines[0], lines[1], lines[2]


def create_zip(project_dir: Path, include_files):
    tmp = tempfile.NamedTemporaryFile(prefix="orange-heart-", suffix=".zip", delete=False)
    tmp.close()
    zip_path = Path(tmp.name)

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in include_files:
            src = project_dir / rel
            if not src.exists():
                raise FileNotFoundError(f"缺少文件: {src}")
            zf.write(src, arcname=rel)

    return zip_path


def run_remote(client: paramiko.SSHClient, command: str, timeout=7200):
    def emit(stream, text: str):
        enc = stream.encoding or "utf-8"
        safe = text.encode(enc, errors="replace").decode(enc, errors="replace")
        stream.write(safe)
        stream.flush()

    stdin, stdout, stderr = client.exec_command(command, get_pty=True, timeout=timeout)
    stdin.close()

    start = time.time()
    while True:
        if stdout.channel.recv_ready():
            out = stdout.channel.recv(4096).decode("utf-8", errors="replace")
            if out:
                emit(sys.stdout, out)

        if stdout.channel.recv_stderr_ready():
            err = stdout.channel.recv_stderr(4096).decode("utf-8", errors="replace")
            if err:
                emit(sys.stderr, err)

        if stdout.channel.exit_status_ready():
            while stdout.channel.recv_ready():
                out = stdout.channel.recv(4096).decode("utf-8", errors="replace")
                if out:
                    emit(sys.stdout, out)
            while stdout.channel.recv_stderr_ready():
                err = stdout.channel.recv_stderr(4096).decode("utf-8", errors="replace")
                if err:
                    emit(sys.stderr, err)
            break

        if time.time() - start > timeout:
            stdout.channel.close()
            raise TimeoutError("远程命令执行超时")

        time.sleep(0.2)

    code = stdout.channel.recv_exit_status()
    if code != 0:
        raise RuntimeError(f"远程命令失败，退出码: {code}")


def build_remote_script(remote_dir: str, domain: str):
    domain_value = domain if domain else "_"
    return f"""set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[1/8] 安装系统依赖..."
apt-get update
apt-get install -y curl ca-certificates gnupg nginx unzip

echo "[2/8] 安装 Node.js 20（如未安装或版本过低）..."
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  MAJOR="$(node -v | sed 's/^v//' | cut -d'.' -f1)"
  if [ "$MAJOR" -lt 18 ]; then
    NEED_NODE=1
  else
    NEED_NODE=0
  fi
fi

if [ "${{NEED_NODE:-0}}" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "[3/8] 安装 PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "[4/8] 解压部署文件..."
mkdir -p "{remote_dir}"
cd "{remote_dir}"
unzip -o orange-heart.zip

echo "[5/8] 安装项目依赖..."
npm install --omit=dev

echo "[6/8] 配置 Nginx..."
cat > /etc/nginx/sites-available/orange-heart.conf <<'EOF'
server {{
    listen 80;
    server_name {domain_value};
    client_max_body_size 10m;

    location / {{
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}
}}
EOF

ln -sf /etc/nginx/sites-available/orange-heart.conf /etc/nginx/sites-enabled/orange-heart.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "[7/8] 启动应用..."
cd "{remote_dir}"
if pm2 describe orange-heart-points >/dev/null 2>&1; then
  pm2 restart orange-heart-points --update-env
else
  pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 startup systemd -u root --hp /root || true
systemctl enable pm2-root || true
systemctl restart pm2-root || true

echo "[8/8] 健康检查..."
ok=0
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "健康检查失败：3000 端口服务未就绪"
  exit 1
fi

echo
curl -I http://127.0.0.1/ | head -n 1
"""


def main():
    parser = argparse.ArgumentParser(description="Deploy orange-heart project to Aliyun ECS.")
    parser.add_argument("--project-dir", default=".", help="项目目录")
    parser.add_argument("--server-file", default="服务器", help="服务器信息文件")
    parser.add_argument("--remote-dir", default="/opt/orange-heart", help="服务器部署目录")
    parser.add_argument("--domain", default="_", help="Nginx server_name，未有域名可用 _")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    server_file = (project_dir / args.server_file).resolve()
    host, user, password = read_server_file(server_file)

    include_files = DEFAULT_FILES
    zip_path = create_zip(project_dir, include_files)
    print(f"[打包完成] {zip_path}")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        print(f"[连接服务器] {user}@{host}")
        client.connect(hostname=host, username=user, password=password, timeout=20)
        sftp = client.open_sftp()

        remote_zip = posixpath.join(args.remote_dir, "orange-heart.zip")
        run_remote(client, f"mkdir -p {args.remote_dir}")
        print(f"[上传文件] {remote_zip}")
        sftp.put(str(zip_path), remote_zip)
        sftp.close()

        script = build_remote_script(args.remote_dir, args.domain)
        escaped = script.replace("'", "'\"'\"'")
        run_remote(client, f"bash -lc '{escaped}'", timeout=7200)
        print("[部署成功] 服务已上线")
        print(f"[访问地址] http://{host}")
        if args.domain and args.domain != "_":
            print(f"[访问域名] http://{args.domain}")
            print("[提示] 如已解析域名，可继续配置 HTTPS")
        else:
            print("[提示] 当前使用 IP 访问。域名解析后可再次执行脚本并传入 --domain your-domain.com")
    finally:
        try:
            client.close()
        except Exception:
            pass
        try:
            os.remove(zip_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
