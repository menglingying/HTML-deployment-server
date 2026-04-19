module.exports = {
  apps: [
    {
      name: 'orange-heart-points',
      script: './server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
