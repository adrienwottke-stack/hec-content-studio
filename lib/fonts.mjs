import fs from 'node:fs/promises';

let fontLookup;
export function trustedFontFile() {
  return fontLookup??=(async()=>{
    // Fixed application-owned candidates only; no provider/user path enters a filter.
    const candidates=process.platform==='win32'?['C:/Windows/Fonts/arial.ttf']:
      ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
    for(const file of candidates)try{await fs.access(file);return file;}catch{}
    return null;
  })();
}

export async function timecodeOverlay(at,{x=8,y=8}={}) {
  if(!Number.isFinite(at)||at<0||![x,y].every(value=>Number.isInteger(value)&&value>=0&&value<=32)) {
    throw new Error('Ungültige Position oder Zeitmarke für die Bildbeschriftung.');
  }
  const font=await trustedFontFile();
  // Image order plus frame/time metadata remains the source of truth without a font.
  if(!font)return '';
  return `,drawtext=fontfile='${font.replace(/:/g,'\\:')}':text='${at.toFixed(3)} s':fontcolor=white:fontsize=18:box=1:boxcolor=black@0.7:x=${x}:y=${y}`;
}
