import fs from 'node:fs/promises';

export class StorageCapacity {
  constructor(config, library, {statfs=fs.statfs}={}) {
    this.config=config; this.library=library; this.statfs=statfs;
  }
  async snapshot(reserved={remaining:0,total:0}) {
    const stats=await this.statfs(this.config.dataDir);
    const totalBytes=Number(stats.blocks)*Number(stats.bsize);
    const freeBytes=Number(stats.bavail)*Number(stats.bsize);
    if(!Number.isSafeInteger(totalBytes)||!Number.isSafeInteger(freeBytes)||totalBytes<=0||freeBytes<0) {
      throw Object.assign(new Error('Der freie Speicherplatz konnte nicht bestätigt werden.'),{status:503});
    }
    const usedBytes=this.library.bytes(),reserveBytes=this.config.storageReserveBytes;
    const diskAvailable=Math.max(0,freeBytes-reserveBytes-reserved.remaining);
    const quotaAvailable=this.config.maxStorageBytes?Math.max(0,this.config.maxStorageBytes-usedBytes-reserved.total):Infinity;
    const availableBytes=Math.min(diskAvailable,quotaAvailable);
    return {usedBytes,totalBytes,freeBytes,reserveBytes,availableBytes,
      reservedBytes:reserved.remaining,mode:this.config.maxStorageBytes?'quota':'volume',
      maxBytes:this.config.maxStorageBytes||usedBytes+Math.max(0,freeBytes-reserveBytes)};
  }
  async require(bytes,reserved) {
    const storage=await this.snapshot(reserved);
    if(bytes>storage.availableBytes) throw Object.assign(new Error(
      `Zu wenig freier Speicher für diese Aufnahme. Noch ${(storage.availableBytes/1024**3).toFixed(1)} GB für neue Uploads verfügbar; Platz für Vorschauen und Exporte ist reserviert.`),{status:507});
    return storage;
  }
}
