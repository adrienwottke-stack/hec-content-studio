import fs from 'node:fs/promises';

const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(buffer){let crc=0xffffffff;for(const byte of buffer)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
// JPEGs are already compressed. Stream one bounded file at a time into a ZIP.
export async function writePhotoZip(target,entries,signal) {
  const file=await fs.open(target,'w',0o600),central=[];let position=0;
  try {
    for(const entry of entries) {
      signal?.throwIfAborted();
      if(!/^foto-[a-f0-9]{32}\.jpg$/.test(entry.name))throw new Error('Ungültiger ZIP-Dateiname.');
      const data=await fs.readFile(entry.path);if(data.length>32*1024**2)throw new Error('Foto überschreitet das ZIP-Dateilimit.');
      const name=Buffer.from(entry.name),crc=crc32(data),header=Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);
      header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
      const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);
      record.writeUInt16LE(0x800,8);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(position,42);
      await file.writeFile(header);await file.writeFile(name);await file.writeFile(data);
      central.push(Buffer.concat([record,name]));position+=header.length+name.length+data.length;
    }
    const start=position;
    for(const record of central){await file.writeFile(record);position+=record.length;}
    const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(position-start,12);end.writeUInt32LE(start,16);await file.writeFile(end);await file.sync();
  } finally {await file.close();}
  await verifyPhotoZip(target,entries);
}
export async function verifyPhotoZip(target,entries) {
  const file=await fs.open(target,'r');
  try {
    const size=(await file.stat()).size,end=Buffer.alloc(22);await file.read(end,0,22,size-22);
    if(end.readUInt32LE(0)!==0x06054b50||end.readUInt16LE(10)!==entries.length)throw new Error('ZIP-Inhaltsverzeichnis ist unvollständig.');
    let position=0;
    for(const entry of entries) {
      const header=Buffer.alloc(30);await file.read(header,0,30,position);
      if(header.readUInt32LE(0)!==0x04034b50)throw new Error('Ungültiger ZIP-Eintrag.');
      const length=header.readUInt32LE(18),nameLength=header.readUInt16LE(26),extra=header.readUInt16LE(28),name=Buffer.alloc(nameLength);
      await file.read(name,0,nameLength,position+30);if(name.toString()!==entry.name||length>32*1024**2)throw new Error('ZIP-Quelle stimmt nicht.');
      const data=Buffer.alloc(length);const read=await file.read(data,0,length,position+30+nameLength+extra);
      if(read.bytesRead!==length||crc32(data)!==header.readUInt32LE(14))throw new Error('ZIP-Fotoprüfsumme stimmt nicht.');
      position+=30+nameLength+extra+length;
    }
    if(position!==end.readUInt32LE(16))throw new Error('ZIP hat unerwartete Einträge.');
  } finally {await file.close();}
}
