module.exports = {
  apps: [
    {
      name: "qahwa-tasks",
      cwd: "/home/burawi/qahwa-tasks",
      script: "dist/server/server/index.js",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3022",
        PUBLIC_BASE_URL: "https://tasks.qahwa.pro",
        DATA_DIR: "/home/burawi/.local/share/qahwa-tasks",
        BACKUP_DIR: "/home/burawi/.local/share/qahwa-tasks/backups",
        QAHWA_NOTIFY_URL: "http://127.0.0.1:3020",
        QAHWA_NOTIFY_TOKEN_FILE: "/home/burawi/.config/qahwa-notify/send.token",
        SESSION_DAYS: "365"
      },
      max_memory_restart: "350M",
      exp_backoff_restart_delay: 100,
      time: true
    }
  ]
};
