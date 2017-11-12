module.exports = ({protocol = 'http', host = '127.0.0.1', port = 8000} = {}) => {
  global.location = {
    protocol: protocol + ':',
    host: host + ':' + port,
    pathname: '/',
  };
  global.WebSocket = require('ws/lib/WebSocket.js');
  const archae = require('.');
  return archae;
};
