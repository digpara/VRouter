import Utils from './utils'
import logger from './logger'

const fs = require('fs-extra')
const path = require('path')
const os = require('os')

/*
 * 根据rule, 生成PREROUTING和OUTPUT两条iptables规则
 */
function genFWRulesHelper (rule) {
  return `iptables -t nat -A PREROUTING ${rule}\niptables -t nat -A OUTPUT ${rule}`
}

async function genIPsetFileHelper (fPath, ipsetName) {
  const contents = []

  const list = await fs.readFile(fPath, 'utf8')

  list.split('\n').forEach((line) => {
    const trimLine = line.trim()

    if (!/^#/ig.test(trimLine) && !/^$/ig.test(trimLine)) {
      const pattern = /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/g
      if (pattern.test(trimLine)) {
        contents.push(`add ${ipsetName} ${trimLine}`)
      }
    }
  })

  return contents
}

async function genDnsmasqHelper (fPath, dnsServer, ipsetName) {
  const list = await fs.readFile(fPath, 'utf8')

  const contents = []

  list.split('\n').forEach((line) => {
    const trimLine = line.trim()

    if (!/^#/ig.test(trimLine) && !/^$/ig.test(trimLine)) {
      const IPPattern = /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/g

      if (!IPPattern.test(trimLine)) {
        if (dnsServer) {
          contents.push(`server=/${trimLine}/${dnsServer}`)
        }
        contents.push(`ipset=/${trimLine}/${ipsetName}`)
      }
    }
  })

  return contents
}

/*
 * @param {object} profile 配置信息
 * @param {object} proxiesInfo: {shadowsocks, shadowsocksr, kcptun, tunnelDns} 各代理的端口信息
 */
async function getSsCfgFrom (profile, proxiesInfo) {
  const data = profile.shadowsocks
  const cfg = {
    'server': data.server,
    'server_port': data.server_port,
    'local_address': '0.0.0.0',
    'local_port': proxiesInfo.shadowsocks.localPort,
    'password': data.password,
    'timeout': data.timeout,
    'method': data.method,
    'fast_open': data.fast_open,
    'mode': 'tcp_only'
  }
  if (profile.proxies === 'ssKt') {
    cfg.server = '127.0.0.1'
    cfg.server_port = proxiesInfo.kcptun.localPort
  } else {
    cfg.server = await Utils.resolveDomain(cfg.server)
  }
  return cfg
}

async function getSsrCfgFrom (profile, proxiesInfo) {
  const data = profile.shadowsocksr
  const cfg = {
    'server': data.server,
    'server_port': data.server_port,
    'local_address': '0.0.0.0',
    'local_port': proxiesInfo.shadowsocksr.localPort,
    'password': data.password,
    'timeout': data.timeout,
    'method': data.method,
    'fast_open': data.fast_open,
    'mode': 'tcp_oly',
    'protocol': data.protocol,
    'protocol_param': data.protocol_param,
    'obfs': data.obfs,
    'obfs_param': data.obfs_param
  }
  data.others.split(';').forEach((kv) => {
    if (kv.trim()) {
      const [k, v] = kv.split('=')
      cfg[k.trim()] = v.trim()
    }
  })
  if (profile.proxies === 'ssrKt') {
    cfg.server = '127.0.0.1'
    cfg['server_port'] = proxiesInfo.kcptun.localPort
  } else {
    cfg.server = await Utils.resolveDomain(cfg.server)
  }
  return cfg
}

async function getTunnelDnsCfgFrom (profile, proxiesInfo) {
  const type = /ssr/ig.test(profile.proxies) ? 'shadowsocksr' : 'shadowsocks'
  const cfg = type === 'shadowsocksr'
    ? await getSsrCfgFrom(profile, proxiesInfo)
    : await getSsCfgFrom(profile, proxiesInfo)

  if (/kt/ig.test(profile.proxies)) {
    cfg.server = await Utils.resolveDomain(profile.kcptun.server)
    cfg.server_port = profile[type].server_port
  }
  cfg.local_port = proxiesInfo.tunnelDns.localPort
  cfg.mode = 'udp_only'
  // fast_open not work in ss-tunnel
  cfg.fast_open = false
  cfg.tunnel_address = profile.dnsServer || '8.8.8.8:53'
  return cfg
}
async function getKtCfgFrom (profile, proxiesInfo) {
  const data = profile.kcptun
  const serverIP = await Utils.resolveDomain(data.server)
  const cfg = {
    'remoteaddr': `${serverIP}:${data.server_port}`,
    'localaddr': `:${proxiesInfo.kcptun.localPort}`,
    'key': data.key,
    'crypt': data.crypt,
    'mode': data.mode
  }
  data.others.split(';').forEach((kv) => {
    if (kv.trim()) {
      const [k, v] = kv.split('=')
      const value = v.trim().replace(/"/g, '')
      const key = k.trim()
      // kcptun can not parse a config file with quote-wrapped value of number/boolean
      if (/^\d+$/g.test(value)) {
        cfg[key] = parseInt(value)
      } else if (/^true|false$/g.test(value)) {
        cfg[key] = value === 'true'
      } else {
        cfg[key] = value
      }
    }
  })
  return cfg
}
async function getRelayUDPCfgFrom (profile, proxiesInfo) {
  const type = /ssr/ig.test(profile.proxies) ? 'shadowsocksr' : 'shadowsocks'
  const cfg = type === 'shadowsocksr'
    ? await getSsrCfgFrom(profile, proxiesInfo)
    : await getSsCfgFrom(profile, proxiesInfo)

  if (/kt/ig.test(profile.proxies)) {
    cfg.server = await Utils.resolveDomain(profile.kcptun.server)
    cfg.server_port = profile[type].server_port
  }
  cfg.local_port = proxiesInfo.relayUDP.localPort
  cfg.mode = 'udp_only'
  return cfg
}

/*
 * @return {string} cfg temppath
 */
async function genProxyCfgHelper (proxy, profile, proxiesInfo) {
  const cfgName = proxiesInfo[proxy].cfgName
  const tempFPath = path.join(os.tmpdir(), cfgName)
  await fs.remove(tempFPath).catch()
  let func = null
  switch (proxy) {
    case 'shadowsocks':
      func = getSsCfgFrom
      break
    case 'shadowsocksr':
      func = getSsrCfgFrom
      break
    case 'tunnelDns':
      func = getTunnelDnsCfgFrom
      break
    case 'kcptun':
      func = getKtCfgFrom
      break
    case 'relayUDP':
      func = getRelayUDPCfgFrom
      break
  }
  const data = await func(profile, proxiesInfo)
  await fs.writeJson(tempFPath, data, {spaces: 2})
  return tempFPath
}

async function genServiceFileHelper (proxy, proxies, proxiesInfo, remoteCfgDirPath) {
  let serviceName = proxiesInfo[proxy].serviceName
  let binName = proxiesInfo[proxy].binName
  // if (proxy === 'tunnelDns' || proxy === 'relayUDP') {
  if (/^(tunnelDns|relayUDP)$/ig.test(proxy)) {
    binName = /ssr/ig.test(proxies) ? binName.shadowsocksr : binName.shadowsocks
    serviceName = /ssr/ig.test(proxies) ? serviceName.shadowsocksr : serviceName.shadowsocks
  }
  const binPath = `/usr/bin/${binName}`
  const cfgPath = `${remoteCfgDirPath}/${proxiesInfo[proxy].cfgName}`
  const tempFPath = path.join(os.tmpdir(), serviceName)
  await fs.remove(tempFPath).catch()

  // fixme: 因为relayUDP的binname和ss/ssr相同, 所有停止relayUDP service的时候会把ss/ssr的进程也停止
  // 另一个可能的情况是: ss/ssr的进程被停止, 但是realyUDP自身的进程却没被停止
  const content = String.raw`#!/bin/sh /etc/rc.common
            # Copyright (C) 2006-2011 OpenWrt.org
            START=95
            SERVICE_USE_PID=1
            SERVICE_WRITE_PID=1
            SERVICE_DAEMONIZE=1
            start() {
                service_start ${binPath} -c ${cfgPath}
            }
            stop() {
                service_stop ${binPath}
            }`
  await fs.outputFile(tempFPath, content)
  return tempFPath
}
function genWatchdogFileHelper (proxy, proxies, proxiesInfo) {
  let binName = proxiesInfo[proxy].binName
  let serviceName = proxiesInfo[proxy].serviceName
  if (/^(tunnelDns|relayUDP)$/ig.test(proxy)) {
    binName = /ssr/ig.test(proxies) ? binName.shadowsocksr : binName.shadowsocks
    serviceName = /ssr/ig.test(proxies) ? serviceName.shadowsocksr : serviceName.shadowsocks
  }
  const cfgName = proxiesInfo[proxy].cfgName

  const script = String.raw`
    output=$(ps -w| grep "${binName} -[c] .*${cfgName}")
    if [[ -z "$output" ]];then
      /etc/init.d/${serviceName} restart
    fi`
  return script
}

function collectIpsetNames (ipsetArray) {
  const ipsetNames = new Set()
  for (let i = 0; i < ipsetArray.length; i++) {
    const { ipsetName } = ipsetArray[i]
    ipsetNames.add(ipsetName)
  }
  return Array.from(ipsetNames)
}

function getFileIpsetPairArray (profile, proxiesInfo, firewallInfo, dirPath) {
  const dnsServer = profile.enableTunnelDns
    ? `127.0.0.1#${proxiesInfo.tunnelDns.localPort}`
    : profile.dnsServer
  const ipsetArray = []

  for (let key in profile.selectedBL) {
    // "selectedBL": {"gfwList":true, "extraBlackList":true},
    if (profile.selectedBL[key] === false) {
      continue
    }

    const item = {
      fPath: path.join(dirPath, firewallInfo.lists[`${key}Fname`]),
      dnsServer: dnsServer,
      ipsetName: firewallInfo.ipset.blackSetName
    }
    ipsetArray.push(item)
  }

  for (let key in profile.selectedWL) {
    // "selectedWL": {"chinaIPs":true, "lanNetworks":true, "extraWhiteList":true},
    if (profile.selectedWL[key] === false) {
      continue
    }

    const name = key === 'lanNetworks'
      ? firewallInfo.ipset.lanSetName
      : firewallInfo.ipset.whiteSetName
    const item = {
      fPath: path.join(dirPath, firewallInfo.lists[`${key}Fname`]),
      dnsServer: dnsServer,
      ipsetName: name
    }
    ipsetArray.push(item)
  }

  return ipsetArray
}

class Generator {
  /*
   * @param {object} options: {mode, list: [{file, dnsServer, ipsetName}]}
   */
  static async genDnsmasqCfgFile (profile, proxiesInfo, firewallInfo, dirPath) {
    const tempFPath = path.join(os.tmpdir(), 'custom.conf')
    await fs.remove(tempFPath).catch()

    let contents = []

    if (profile.mode === 'none') {
      contents.push('# stay in wall')
      await fs.outputFile(tempFPath, contents.join('\n'), 'utf8')
      return tempFPath
    }

    const listArray = getFileIpsetPairArray(profile, proxiesInfo, firewallInfo, dirPath)
    for (let i = 0; i < listArray.length; i++) {
      const { fPath, dnsServer, ipsetName } = listArray[i]
      const subs = await genDnsmasqHelper(fPath, dnsServer, ipsetName)
      contents = contents.concat(subs)
    }

    await fs.outputFile(tempFPath, contents.join('\n'), 'utf8')
    return tempFPath
  }

  /*
   * @param {object} options: {priority, binPath, cfgPath}
   * @param {string} out
   */
  static async genServicesFiles (profile, proxiesInfo, remoteCfgDirPath, scpAllService) {
    const cfgFiles = []
    const proxies = profile.proxies
    if (scpAllService || profile.enableTunnelDns) {
      cfgFiles.push(await genServiceFileHelper('tunnelDns', 'ss', proxiesInfo, remoteCfgDirPath))
      cfgFiles.push(await genServiceFileHelper('tunnelDns', 'ssr', proxiesInfo, remoteCfgDirPath))
    }
    if (scpAllService || profile.enableRelayUDP) {
      cfgFiles.push(await genServiceFileHelper('relayUDP', 'ss', proxiesInfo, remoteCfgDirPath))
      cfgFiles.push(await genServiceFileHelper('relayUDP', 'ssr', proxiesInfo, remoteCfgDirPath))
    }
    if (scpAllService || /kt/ig.test(proxies)) {
      cfgFiles.push(await genServiceFileHelper('kcptun', proxies, proxiesInfo, remoteCfgDirPath))
    }
    if (scpAllService || /ssr/ig.test(proxies)) {
      cfgFiles.push(await genServiceFileHelper('shadowsocksr', proxies, proxiesInfo, remoteCfgDirPath))
    }
    if (scpAllService || /^ss(kt)?$/ig.test(proxies)) {
      cfgFiles.push(await genServiceFileHelper('shadowsocks', proxies, proxiesInfo, remoteCfgDirPath))
    }
    return cfgFiles
  }

  static async genIptablesFile (profile, proxiesInfo, firewallInfo, remoteCfgDirPath) {
    const tempFPath = path.join(os.tmpdir(), firewallInfo.firewallFname)
    await fs.remove(tempFPath).catch()

    const proxies = profile.proxies
    // kcptun 在 shadowsocks[r] 后端, 并不需要在firewall中转发
    const type = /ssr/ig.test(proxies) ? 'shadowsocksr' : 'shadowsocks'
    const redirPort = proxiesInfo[type].localPort
    const udpRedirPort = proxiesInfo.relayUDP.localPort

    logger.debug(`tcp redirPort: ${redirPort}`)
    logger.debug(`udp redirPort: ${udpRedirPort}`)

    const contents = ['# com.icymind.vrouter']
    contents.push(`# workMode: ${profile.mode}`)
    contents.push('ipset flush')
    contents.push(`/usr/sbin/ipset restore -f -! ${remoteCfgDirPath}/${firewallInfo.ipsetFname} &> /dev/null`)

    // if kcp protocol: speedup ssh
    if (/kt/ig.test(proxies) && profile.speedupServerSSH) {
      contents.push('\n# speedup server ssh connection')
      const rule = `-d ${profile.kcptun.server} -p tcp --dport ${profile.serverSSHPort} -j REDIRECT --to-port ${redirPort}`
      contents.push(genFWRulesHelper(rule))
    }

    // bypass serverIPs
    // bypass shadowsocks server_ip
    contents.push('\n# bypass server ip')
    const ips = []
    ;/kt/ig.test(proxies) && ips.push(profile.kcptun.server)
    ;/ssr/ig.test(proxies) && ips.push(profile.shadowsocksr.server)
    ;/^ss(kt)?$/ig.test(proxies) && ips.push(profile.shadowsocks.server)
    for (let i = 0; i < ips.length; i++) {
      const pattern = /\d+.\d+.\d+.\d+/g
      let ip = ips[i]
      if (!pattern.test(ip)) {
        ip = await Utils.resolveDomain(ips[i])
      }
      contents.push(genFWRulesHelper(`-d ${ip} -j RETURN`))
      // bypass udp to serverIP to-port
      contents.push(`iptables -t mangle -A PREROUTING -p udp -d ${ip} -j RETURN`)
    }

    // bypass lan_networks. 如果不想绕过lan, 生成一个空的lan ipset集合即可
    contents.push('\n# bypass lan networks')
    const rule = `-m set --match-set ${firewallInfo.ipset.lanSetName} dst -j RETURN`
    contents.push(genFWRulesHelper(rule))
    // bypass udp too
    contents.push(`iptables -t mangle -A PREROUTING -p udp -m set --match-set ${firewallInfo.ipset.lanSetName} dst -j RETURN`)

    // whitelist mode: bypass whitelist and route others
    if (profile.mode === 'whitelist') {
      // "绕过白名单"模式下, 先将黑名单导向代理(如果自定义黑名单中存在白名单相同项, 先处理黑名单符合预期)
      contents.push('\n# route all blacklist traffic')
      let rule = `-p tcp -m set --match-set ${firewallInfo.ipset.blackSetName} dst -j REDIRECT --to-port ${redirPort}`
      contents.push(genFWRulesHelper(rule))

      if (profile.enableRelayUDP) {
        contents.push('ip rule add fwmark 1 lookup 100')
        contents.push('ip route add local default dev lo table 100 2>/dev/null')
        contents.push(`iptables -t mangle -A PREROUTING -p udp -m set --match-set ${firewallInfo.ipset.blackSetName} dst -j TPROXY --on-port ${udpRedirPort} --tproxy-mark 0x01/0x01`)
      }

      contents.push('\n# bypass whitelist')
      rule = `-m set --match-set ${firewallInfo.ipset.whiteSetName} dst -j RETURN`
      contents.push(genFWRulesHelper(rule))

      contents.push('\n# route all other traffic')
      rule = `-p tcp -j REDIRECT --to-port ${redirPort}`
      contents.push(genFWRulesHelper(rule))

      if (profile.enableRelayUDP) {
        contents.push(`iptables -t mangle -A PREROUTING -p udp -j TPROXY --on-port ${udpRedirPort} --tproxy-mark 0x01/0x01`)
      }
    } else if (profile.mode === 'blacklist') {
      // 仅代理黑名单模式下, 先将白名单返回(如果自定义白名单中存在黑名单相同项, 先处理白名单符合预期)
      contents.push('\n# bypass whitelist')
      let rule = `-m set --match-set ${firewallInfo.ipset.whiteSetName} dst -j RETURN`
      contents.push(genFWRulesHelper(rule))

      contents.push('\n# route all blacklist traffic')
      rule = `-p tcp -m set --match-set ${firewallInfo.ipset.blackSetName} dst -j REDIRECT --to-port ${redirPort}`
      contents.push(genFWRulesHelper(rule))

      if (profile.enableRelayUDP) {
        contents.push('ip rule add fwmark 1 lookup 100')
        contents.push('ip route add local default dev lo table 100')
        contents.push(`iptables -t mangle -A PREROUTING -p udp -m set --match-set ${firewallInfo.ipset.blackSetName} dst -j TPROXY --on-port ${udpRedirPort} --tproxy-mark 0x01/0x01`)
      }
    } else if (profile.mode === 'global') {
      contents.push('\n# route all traffic')
      let rule = `-p tcp -j REDIRECT --to-port ${redirPort}`
      contents.push(genFWRulesHelper(rule))

      if (profile.enableRelayUDP) {
        contents.push('ip rule add fwmark 1 lookup 100')
        contents.push('ip route add local default dev lo table 100')
        contents.push(`iptables -t mangle -A PREROUTING -p udp -j TPROXY --on-port ${udpRedirPort} --tproxy-mark 0x01/0x01`)
      }
    }

    await fs.outputFile(tempFPath, contents.join('\n'), 'utf8')
    return tempFPath
  }

  /*
   * @param {array} ipset: [{fPath, ipsetName}]
   */
  static async genIpsetFile (profile, proxiesInfo, firewallInfo, dirPath) {
    const tempFPath = path.join(os.tmpdir(), 'custom.ipset')
    await fs.remove(tempFPath).catch()
    let contents = []

    const ipsetArray = getFileIpsetPairArray(profile, proxiesInfo, firewallInfo, dirPath)
    collectIpsetNames(ipsetArray).forEach((ipsetName) => {
      contents.push(`create ${ipsetName} hash:net family inet hashsize 1024 maxelem 65536 -exist`)
    })

    for (let i = 0; i < ipsetArray.length; i++) {
      const {fPath, ipsetName} = ipsetArray[i]
      const subs = await genIPsetFileHelper(fPath, ipsetName)
      contents = contents.concat(subs)
    }
    // merge to file
    await fs.outputFile(tempFPath, contents.join('\n'), 'utf8')
    return tempFPath
  }

  /*
   * @param {object} options: {proxies, enableTunnelDns, servicesName:
   * {tunnelDns: '', shadowsocks: '', shadowsocksr: '', kcptun: ''}}
   */
  static async genWatchdogFile (profile, proxiesInfo) {
    const tempFPath = path.join(os.tmpdir(), 'proxies-watchdog')
    await fs.remove(tempFPath).catch()

    const proxies = profile.proxies
    const contents = ['#!/bin/sh']

    if (profile.enableTunnelDns) {
      contents.push(genWatchdogFileHelper('tunnelDns', proxies, proxiesInfo))
    }
    if (profile.enableRelayUDP) {
      contents.push(genWatchdogFileHelper('relayUDP', proxies, proxiesInfo))
    }
    if (/kt/ig.test(proxies)) {
      contents.push(genWatchdogFileHelper('kcptun', proxies, proxiesInfo))
    }
    if (/ssr/ig.test(proxies)) {
      contents.push(genWatchdogFileHelper('shadowsocksr', proxies, proxiesInfo))
    }
    if (/^ss(kt)?$/ig.test(proxies)) {
      contents.push(genWatchdogFileHelper('shadowsocks', proxies, proxiesInfo))
    }
    await fs.outputFile(tempFPath, contents.join('\n'), 'utf8')
    return tempFPath
  }

  /*
   * @param {object} profile
   * @param {object} proxiesInfo
   */
  static async genProxiesCfgs (profile, proxiesInfo) {
    const cfgFiles = []
    if (profile.enableTunnelDns) {
      cfgFiles.push(await genProxyCfgHelper('tunnelDns', profile, proxiesInfo))
    }
    if (profile.enableRelayUDP) {
      cfgFiles.push(await genProxyCfgHelper('relayUDP', profile, proxiesInfo))
    }
    if (/kt/ig.test(profile.proxies)) {
      cfgFiles.push(await genProxyCfgHelper('kcptun', profile, proxiesInfo))
    }
    if (/ssr/ig.test(profile.proxies)) {
      cfgFiles.push(await genProxyCfgHelper('shadowsocksr', profile, proxiesInfo))
    }
    if (/^ss(kt)?$/ig.test(profile.proxies)) {
      cfgFiles.push(await genProxyCfgHelper('shadowsocks', profile, proxiesInfo))
    }
    return cfgFiles
  }
}

export default Generator
