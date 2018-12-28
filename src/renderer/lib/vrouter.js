import Openwrt from './openwrt.js'
import Utils from './utils.js'
import VBox from './vbox.js'
import logger from './logger'
// const { VBox } = require('./vbox.js')
// const { Openwrt } = require('./openwrt.js')
// const { Utils } = require('./utils.js')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

/*
 * @param {object} info: vmName, hostonlyINC, hostonlyInfIP, bridgeINC
 */
async function initInterface (info) {
  const hostonlyInf = await VBox.getAvailableHostonlyInf(info.hostonlyInfIP, '255.255.255.0')
  logger.info(`hostonlyInf: ${hostonlyInf}`)
  await VBox.initHostonlyNetwork(info.vmName, hostonlyInf, info.hostonlyINC)
  // const activeAdapter = await Utils.getActiveAdapter()
  const bridgeServices = await VBox.getAllBridgeServices()
  logger.info(`bridgeServices: ${bridgeServices}`)
  const bridgeService = await Utils.getBridgeService(bridgeServices)
  logger.info(`actived Bridge Service: ${bridgeService}`)
  await VBox.initBridgeNetwork(info.vmName, bridgeService, info.bridgeINC)
}

/*
 * @param {object} info: imageUrl, imageSha256
 */
async function getImageZipfile (info) {
  let file = path.join(os.tmpdir(), path.basename(info.imageUrl))
  const hashValue = await Utils.hashFile(file)
  if (hashValue !== info.imageSha256) {
    file = await Utils.downloadFile(info.imageUrl)
  }
  return file
}

/*
 * @param {object} info: vmName, imageUrl, imageSha256, cfgDirPath
 */
async function getVDI (info) {
  const vdi = path.join(info.cfgDirPath, info.vmName + '.vdi')
  await fs.remove(vdi).catch()

  const zipfile = await getImageZipfile({
    imageUrl: info.imageUrl,
    imageSha256: info.imageSha256
  })
  const img = await Utils.gunzip(zipfile, path.join(os.tmpdir(), 'temp.img'))
  await VBox.convertImg(img, vdi)
  return vdi
}

/*
 * @param {object} info: vmName, imageUrl, imageSha256, cfgDirPath
 */
async function create (info) {
  await VBox.create(info.vmName)

  let args = ` --ostype "Linux26_64" --memory "256" --cpus "1" ` +
    ` --boot1 "disk" --boot2 "none" --boot3 "none" --boot4 "none" ` +
    ` --audio "none" --vram "16"`
  await VBox.modify(info.vmName, args)

  args = `--name "SATA Controller" --add "sata" --portcount "4" ` +
    `--hostiocache "on" --bootable "on"`
  await VBox.storagectl(info.vmName, args)

  const vdi = await getVDI({
    vmName: info.vmName,
    imageUrl: info.imageUrl,
    imageSha256: info.imageSha256,
    cfgDirPath: info.cfgDirPath
  })
  args = ` --storagectl "SATA Controller" --port "1" ` +
    `--type "hdd" --nonrotational "on" --medium "${vdi}"`
  await VBox.storageattach(info.vmName, args)
}

/*
 * @param {object} info: username, password, socketFPath
 */
function changePwd (info) {
  const cmd = `echo -e '${info.password}\\n${info.password}' | (passwd ${info.username})`
  return Utils.serialExec(info.serialTcpPort, cmd, info.waitForOutput)
}

function installPackage (serialTcpPort, waitForOutput = 20000) {
  const subCmds = []
  subCmds.push(`sed -i 's/downloads.openwrt.org/mirrors.tuna.tsinghua.edu.cn\\/openwrt/g' /etc/opkg/distfeeds.conf`)
  subCmds.push('opkg update')
  subCmds.push('opkg remove dnsmasq && opkg install dnsmasq-full ipset openssh-sftp-server libopenssl rng-tools iptables-mod-tproxy ip')
  subCmds.push('/etc/init.d/dropbear restart')
  subCmds.push('echo "done" > /tmp/log/vrouter')
  const cmd = subCmds.join(' && ')
  /*
   * 用ssh登录后执行的话, 有奇怪的错误发生. 改用serialExec
   * Error: the string "Collected errors:\n * resolve_conffiles: Existing conffile /etc/config/dhcp is different from the conffile in the new package. The new conffile will be placed at /etc/config/dhcp-opkg.\n * resolve_conffiles: Existing conffile /etc/dnsmasq.conf is different from the conffile in the new package. The new conffile will be placed at /etc/dnsmasq.conf-opkg." was thrown, throw an Error :)
   * return this.execute(subCmds.join(' && '))
   */

  // return this.serialExec(subCmds.join(' && '))
  return Utils.serialExec(serialTcpPort, cmd, waitForOutput)
}

/*
 * @param {object} info: lanIP, serialTcpPort
 */
function configLan (info) {
  const subCmds = []
  subCmds.push(`uci set network.lan.ipaddr='${info.lanIP}'`)
  subCmds.push(`uci set network.lan.ipv6='0'`)
  subCmds.push('uci commit network')
  subCmds.push('/etc/init.d/network restart')
  const cmd = subCmds.join(' && ')
  return Utils.serialExec(info.serialTcpPort, cmd, info.waitForOutput)
}

/*
 * @param {object} info: vmName, startType
 */
async function startVrouter (info) {
  await VBox.start(info.vmName, info.startType)
  // mock 'press enter key' to skip grub waiting time
  await Utils.wait(1000)
  await VBox.sendKeystrokesTo(info.vmName)
  await Utils.wait(500)
  await VBox.sendKeystrokesTo(info.vmName)
  await Utils.wait(30000)
}

/*
 * @param {object} info: {vmName, hostonlyINC, hostonlyInfIP, bridgeINC, bridgeMacAddress, lanIP, username, password, serailPort, serialTcpPort, process}
 */
async function init (info) {
  // if (process.env.NODE_ENV !== 'development') {
  //   await VBox.lockGUIConfig(info.vmName, true)
  //   await VBox.hide(info.vmName, true)
  // }
  await VBox.toggleSerialPort(info.vmName, info.serialTcpPort, 'on', info.serialPort)
  await initInterface({
    vmName: info.vmName,
    hostonlyINC: info.hostonlyINC,
    hostonlyInfIP: info.hostonlyInfIP,
    bridgeINC: info.bridgeINC
  })

  info.process.emit('init', '等待虚拟机启动, 请稍候 30 秒')
  await startVrouter({
    vmName: info.vmName,
    startType: 'headless'
  })

  info.process.emit('init', '配置虚拟机网络地址, 请稍候 10 秒')
  await configLan({
    lanIP: info.lanIP,
    serialTcpPort: info.serialTcpPort,
    waitForOutput: 5000
  })
  await Utils.wait(5000)

  info.process.emit('init', '修改虚拟机密码')
  await changePwd({
    username: info.username,
    password: info.password,
    serialTcpPort: info.serialTcpPort,
    waitForOutput: 3000
  })
}

class VRouter extends Openwrt {
  constructor (config) {
    super(config.openwrt)
    this.name = config.virtualbox.vmName
    this.cfgDirPath = path.join(Utils.getAppDir(), config.cfgDirName)
    this.config = config
  }
  async powerOff () {
    await this.disconnect()
    return Utils.serialExec(this.config.virtualbox.serialTcpPort, 'poweroff', 1000)
  }
  async build (process) {
    await this.copyTemplatesIfNotExist()

    process.emit('init', '下载 openwrt 镜像, 创建虚拟机')
    await create({
      vmName: this.name,
      imageUrl: this.config.virtualbox.imageUrl,
      imageSha256: this.config.virtualbox.imageSha256,
      cfgDirPath: this.cfgDirPath
    })

    await init({
      vmName: this.name,
      hostonlyINC: this.config.virtualbox.hostonlyINC,
      hostonlyInfIP: this.config.virtualbox.hostonlyInfIP,
      bridgeINC: this.config.virtualbox.bridgeINC,
      lanIP: this.ip,
      username: this.config.openwrt.username,
      password: this.config.openwrt.password,
      serialPort: this.config.virtualbox.serialPort,
      serialTcpPort: this.config.virtualbox.serialTcpPort,
      process: process
    })

    process.emit('init', '更新软件源并安装必要软件包, 请稍候 20-60 秒')
    await installPackage(this.config.virtualbox.serialTcpPort, 20000)

    const finished = await this._isInstallPackageFinish(4)
    if (!finished) {
      process.emit('init', '未能安装必要软件包')
      throw Error('未能安装必要软件包')
    }
    process.emit('init', '必要软件包安装完成')

    process.emit('init', '配置 Dnsmasq')
    await this.configDnsmasq()

    process.emit('init', '修改虚拟机时区')
    await this.changeTZ(this.name)

    process.emit('init', '打开 tcp fast open')
    await this.turnOnFastOpen()

    await this.manageService('cron', 'enable')

    process.emit('init', '离线安装代理软件包')
    /* global __static */
    await this.installProxies({
      shadowsocks: path.join(__static, 'bin/shadowsocks.tar.gz'),
      shadowsocksr: path.join(__static, 'bin/shadowsocksr.tar.gz'),
      kcptun: path.join(__static, 'bin/kcptun.tar.gz')
    })

    process.emit('init', '拷贝管理脚本到虚拟机')
    await this.scpProxiesServices(this.config.profiles[0], this.config.proxiesInfo, `/etc/${this.config.cfgDirName}`, true)

    process.emit('init', '正在重启虚拟机, 请稍候 40 秒')
    await this.powerOff()
    await Utils.wait(10000)
    await VBox.toggleSerialPort(this.name, this.config.virtualbox.serialTcpPort, 'off')
    await startVrouter({
      vmName: this.name,
      startType: 'headless'
    })
    process.emit('init', '虚拟机就绪')
  }

  async _isInstallPackageFinish (maxRetry = 4) {
    for (let i = 0; i < maxRetry; i++) {
      logger.debug(`check isInstallPackageFinish, time: ${i}`)
      try {
        const log = await this.execute('cat /tmp/log/vrouter')
        if (log.trim() === 'done') {
          return true
        }
      } catch (err) {
        logger.warn(`check isInstallPackageFinish failed, time: ${i}`)
      }
      logger.debug(`wait for ${10000} ms to retry checking isInstallPackageFinish`)
      await Utils.wait(10000)
    }
    return false
  }

  async copyTemplatesIfNotExist () {
    const templatesDir = path.join(__static, 'config-templates')
    const dst = this.cfgDirPath
    await fs.copy(templatesDir, dst, {
      overwrite: false,
      errorOnExist: false
    })
  }

  async updateBridgedAdapter () {
    const bridgeServices = await VBox.getAllBridgeServices()
    logger.info(`Get all bridgeServices: ${bridgeServices}`)
    const bridgeService = await Utils.getBridgeService(bridgeServices)
    if (!bridgeService) return
    logger.info(`Get current actived bridge service: ${bridgeService}`)
    const assignedBridgeService = await VBox.getAssignedBridgeService(this.name, this.config.virtualbox.bridgeINC)
    if (assignedBridgeService !== bridgeService) {
      logger.info(`PrimaryInterface change from ${assignedBridgeService} to ${bridgeService}`)
      await VBox.amendBridgeNetwork(this.name, bridgeService, this.config.virtualbox.bridgeINC)
    }
  }

  saveCfg2File () {
    const cfgPath = path.join(this.cfgDirPath, 'config.json')
    return fs.writeJson(cfgPath, this.config, {spaces: 2})
  }
  async applyActivedProfile () {
    const activedProfile = this.config.profiles.filter(profile => profile.active)[0]
    const proxiesInfo = this.config.proxiesInfo
    const firewallInfo = this.config.firewallInfo
    const remoteCfgDirPath = `/etc/${this.config.cfgDirName}`
    const dnsmasqCfgDir = '/etc/dnsmasq.d'
    await super.applyProfile(activedProfile, proxiesInfo, firewallInfo, remoteCfgDirPath, dnsmasqCfgDir)
  }

  static async getLatestCfg () {
    const templateCfgPath = path.join(__static, 'config-templates', 'config.json')
    const appDirCfgPath = path.join(Utils.getAppDir(), 'vrouter', 'config.json')
    let appDirCfg = {}
    const templateCfg = await fs.readJSON(templateCfgPath)

    try {
      appDirCfg = await fs.readJSON(appDirCfgPath)
    } catch (error) {
      // appdircfg 不存在
      await fs.copy(templateCfgPath, appDirCfgPath)
      return templateCfg
    }

    if (appDirCfg.version < 0.4) {
      // 对 0.4 以下版本不作兼容
      await fs.copy(templateCfgPath, appDirCfgPath)
      return templateCfg
    }

    // appDirCfg 已经是最新版本的配置文件
    return appDirCfg
  }
}
export default VRouter
