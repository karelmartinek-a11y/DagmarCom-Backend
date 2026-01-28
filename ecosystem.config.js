module.exports = {
  apps: [
    {
      name: 'dagmarcom',
      script: './src/server.js',
      env: {
        PORT: 9001,
        BASIC_USER: 'admin',
        BASIC_PASS: '+Sin8glov8',
        DB_PATH: './data/dagmarcom.db',
        DELETE_BASE_URL: 'https://api.hcasc.cz/delete',
        LOG_LEVEL: 'info'
      }
    }
  ]
};
