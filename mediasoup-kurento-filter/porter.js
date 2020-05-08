
const getPort = require('find-free-port');
const localhost = '127.0.0.1';
const minPort = 10000;
const maxPort = 65535;

function porterFactory(ip) {
  return new Porter(ip);
}

function Porter(targetIp) {
  this.startPort = minPort;
  this.endPort = maxPort;
  this.targetIp = targetIp || localhost;
}

Porter.prototype.getMediaPorts = async function (numberOfPorts) {
  let [artp, artcp, vrtp, vrtcp] = await getPort(
    this.startPort,
    this.endPort,
    this.targetIp,
    numberOfPorts
  );

  this.startPort = vrtcp + 1;

  return {artp, artcp, vrtp, vrtcp};
};

module.exports = porterFactory;
