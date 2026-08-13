# 阿里云 Ubuntu 无 Docker 部署

本文适用于 2 核 2 GiB、Ubuntu 22.04、40 GiB 系统盘的阿里云 ECS。架构为 Nginx + Node.js + 本机 MySQL 8，不使用 Docker。

## 一、上线顺序

建议先用公网 IP 完成部署和功能验证，再处理域名、ICP备案接入与 HTTPS。正式开放前必须设置团队访问密码，MySQL 端口不得暴露到公网。

持久数据分为两部分：

- MySQL 数据库 `kol_campaign_os`；
- 上传文件 `/var/lib/kol-campaign-os/data/uploads`。

代码发布到 `/opt/kol-campaign-os/releases/<版本>`，`/opt/kol-campaign-os/current` 指向当前版本。每个版本里的 `data` 都链接到上述持久目录，所以切换版本不会覆盖上传文件。

## 二、阿里云控制台

安全组入方向只保留：

- TCP 22：部署完成前最好限制为管理员当前公网 IP；
- TCP 80：HTTP；
- TCP 443：HTTPS。

不要添加 TCP 3306 或 5001 的公网规则。

## 三、初始化 Ubuntu

以具有 sudo 权限的用户登录服务器：

```bash
sudo apt update
sudo apt install -y nginx mysql-server unzip curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
mysql --version
```

为 2 GiB 内存实例创建 4 GiB Swap：

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

限制 MySQL 在小内存实例上的占用：

```bash
sudo tee /etc/mysql/mysql.conf.d/kol-campaign-os.cnf >/dev/null <<'EOF'
[mysqld]
bind-address = 127.0.0.1
max_connections = 30
innodb_buffer_pool_size = 256M
performance_schema = OFF
EOF
sudo systemctl restart mysql
```

创建服务账号与目录：

```bash
sudo useradd --system --home /opt/kol-campaign-os --shell /usr/sbin/nologin kolapp
sudo install -d -o kolapp -g kolapp -m 0750 /opt/kol-campaign-os/releases
sudo install -d -o kolapp -g kolapp -m 0750 /var/lib/kol-campaign-os/data/uploads
sudo install -d -o root -g kolapp -m 0750 /etc/kol-campaign-os
sudo install -d -o root -g root -m 0750 /var/backups/kol-campaign-os
```

## 四、创建数据库

先生成两个互不相同的随机密码：数据库密码与团队访问密码。

```bash
openssl rand -base64 36
openssl rand -base64 36
```

进入 MySQL：

```bash
sudo mysql
```

将下方密码替换后执行；密码中如果包含单引号，需要换一个密码或按 MySQL 规则转义：

```sql
CREATE DATABASE kol_campaign_os CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'kol_user'@'127.0.0.1' IDENTIFIED BY '替换为数据库随机密码';
GRANT ALL PRIVILEGES ON kol_campaign_os.* TO 'kol_user'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

## 五、制作并上传发布包

在 Windows 项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-linux-release.ps1
```

产物位于 `dist/kol-campaign-os-linux-<版本>.tar.gz`。用阿里云控制台文件上传、SCP 或 WinSCP 将它上传到服务器当前登录用户的主目录。

在服务器解压，以下以版本 `1.0.0` 为例：

```bash
sudo install -d -o kolapp -g kolapp -m 0750 /opt/kol-campaign-os/releases/1.0.0
sudo tar -xzf ~/kol-campaign-os-linux-1.0.0.tar.gz -C /opt/kol-campaign-os/releases/1.0.0
sudo ln -s /var/lib/kol-campaign-os/data /opt/kol-campaign-os/releases/1.0.0/data
sudo chown -R kolapp:kolapp /opt/kol-campaign-os/releases/1.0.0
sudo -u kolapp npm --prefix /opt/kol-campaign-os/releases/1.0.0/server ci --omit=dev
```

## 六、配置环境变量

把仓库中的 `deploy/kol-campaign-os.env.example` 上传或复制为：

```text
/etc/kol-campaign-os/kol-campaign-os.env
```

至少替换 `DB_PASSWORD` 和 `APP_ACCESS_PASSWORD`，然后限制权限：

```bash
sudo chown root:kolapp /etc/kol-campaign-os/kol-campaign-os.env
sudo chmod 0640 /etc/kol-campaign-os/kol-campaign-os.env
```

环境文件必须使用简单的 `KEY=value` 格式。随机密码如果含空格、`#` 或引号，应重新生成一个不含这些字符的密码。

## 七、初始化或迁移数据库

### 方案 A：全新数据库

首次初始化必须显式执行迁移。项目为了保护生产数据，会拒绝在 `NODE_ENV=production` 下自动执行待处理迁移：

```bash
cd /opt/kol-campaign-os/releases/1.0.0
set -a
source /etc/kol-campaign-os/kol-campaign-os.env
set +a
NODE_ENV=development node -e "require('./server/database').initDatabase().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); })"
```

仅在已经备份数据库并审阅当前版本迁移后执行此命令。正式服务仍使用 `NODE_ENV=production`。

### 方案 B：迁移现有数据库

先在原电脑导出：

```powershell
mysqldump --host=127.0.0.1 --port=3306 --user=kol_user --password --single-transaction --routines --triggers --default-character-set=utf8mb4 kol_campaign_os > kol_campaign_os.sql
```

将 SQL 文件传到服务器，然后导入：

```bash
mysql --host=127.0.0.1 --user=kol_user --password kol_campaign_os < ~/kol_campaign_os.sql
```

把原项目 `data/uploads` 的内容复制到 `/var/lib/kol-campaign-os/data/uploads`。导入完成后，仍应按“方案 A”的命令显式应用新版本中尚未执行的迁移。

## 八、首次启动

切换当前版本：

```bash
sudo ln -sfn /opt/kol-campaign-os/releases/1.0.0 /opt/kol-campaign-os/current
```

把仓库中的 systemd 和 Nginx 模板复制到系统目录：

```bash
sudo cp /opt/kol-campaign-os/current/deploy/kol-campaign-os.service /etc/systemd/system/
sudo cp /opt/kol-campaign-os/current/deploy/nginx-kol-campaign-os.conf /etc/nginx/sites-available/kol-campaign-os
sudo ln -sfn /etc/nginx/sites-available/kol-campaign-os /etc/nginx/sites-enabled/kol-campaign-os
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now kol-campaign-os nginx
```

检查：

```bash
systemctl status kol-campaign-os --no-pager
curl http://127.0.0.1:5001/api/health
curl http://127.0.0.1/api/health
journalctl -u kol-campaign-os -n 100 --no-pager
```

现在可以临时访问 `http://服务器公网IP`。正式公开前应完成域名备案接入和 HTTPS。

## 九、每日备份

安装仓库中的备份脚本和定时器：

```bash
sudo install -o root -g root -m 0750 /opt/kol-campaign-os/current/deploy/backup-kol-campaign-os.sh /usr/local/sbin/backup-kol-campaign-os
sudo cp /opt/kol-campaign-os/current/deploy/backup-kol-campaign-os.service /etc/systemd/system/
sudo cp /opt/kol-campaign-os/current/deploy/backup-kol-campaign-os.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-kol-campaign-os.timer
sudo systemctl start backup-kol-campaign-os.service
sudo systemctl status backup-kol-campaign-os.service --no-pager
sudo systemctl list-timers backup-kol-campaign-os.timer
```

备份保存在 `/var/backups/kol-campaign-os`，默认保留 14 天。服务器本机备份不能替代异地备份；稳定运行后应再同步到 OSS 或另一台设备。

## 十、更新与回滚

更新时上传新版本到新的 release 目录，安装依赖并先备份：

```bash
sudo systemctl start backup-kol-campaign-os.service
```

显式执行待处理迁移后再切换 `current` 并重启：

```bash
sudo ln -sfn /opt/kol-campaign-os/releases/新版本 /opt/kol-campaign-os/current
sudo systemctl restart kol-campaign-os
```

如果只是代码问题，可将 `current` 重新指向旧版本并重启。数据库迁移可能无法安全回滚，因此发布前数据库备份是必须步骤。

## 十一、域名与 HTTPS

在工信部备案系统确认主域名状态，并在阿里云备案控制台检查是否需要接入备案。之后将子域名（例如 `kol.example.com`）解析到服务器公网 IP，把 Nginx 配置的 `server_name _;` 改为真实域名，再使用阿里云免费证书或 Certbot 配置 HTTPS。

## 十二、上线验收

- 未登录访问会进入团队口令页面；
- 客户、项目、KOL、视频和审批数据完整；
- 文件上传和下载正常；
- 邮件 IMAP/SMTP 连通；
- AI、ScrapeCreators、飞书等外部 API 连通；
- 重启服务器后应用和 MySQL 自动恢复；
- 手动备份成功且压缩包可读取；
- 3306 和 5001 无法从公网连接。
