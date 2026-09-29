import * as os from "os";

// Host CPU and memory for the sidebar status panel. CPU usage is measured
// between two consecutive snapshots.
export class SystemMonitor {
  private prevIdle = 0;
  private prevTotal = 0;

  constructor() {
    [this.prevIdle, this.prevTotal] = cpuTimes();
  }

  snapshot(): {
    osName: string;
    osArch: string;
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    memTotal: number;
    memUsed: number;
    uptime: number;
    hostname: string;
  } {
    const cpus = os.cpus();
    const [idle, total] = cpuTimes();
    const idleDelta = idle - this.prevIdle;
    const totalDelta = total - this.prevTotal;
    const cpuUsage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    this.prevIdle = idle;
    this.prevTotal = total;

    return {
      osName: `${os.type()} ${os.release()}`,
      osArch: os.arch(),
      cpuModel: cpus[0]?.model ?? "Unknown",
      cpuCores: cpus.length,
      cpuUsage,
      memTotal: os.totalmem(),
      memUsed: os.totalmem() - os.freemem(),
      uptime: os.uptime(),
      hostname: os.hostname(),
    };
  }
}

function cpuTimes(): [idle: number, total: number] {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return [idle, total];
}
