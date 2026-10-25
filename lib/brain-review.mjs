import { cleanText,validateCatalog } from './catalog.mjs';

export function validateReview(raw,asset) {
  const catalog=validateCatalog(raw?.catalog,asset.duration);
  const assessment=raw?.assessment;
  if(!assessment || !['strong','supporting','needs-context','unsuitable'].includes(assessment.use)) throw new Error('Die Verwendung ist ungültig.');
  if(!Array.isArray(raw.ideas)||raw.ideas.length>3 || !Array.isArray(raw.limitations)||raw.limitations.length>8) throw new Error('Die Auswertung ist ungültig.');
  return {catalog,assessment:{use:assessment.use,reason:cleanText(assessment.reason,1000,'Begründung',true),
    nextStep:cleanText(assessment.nextStep,700,'Nächster Schritt',true)},
    ideas:raw.ideas.map(idea=>{
      if(!['followers','event'].includes(idea.goal)) throw new Error('Ungültiges Reel-Ziel.');
      return {title:cleanText(idea.title,100,'Idee',true),hook:cleanText(idea.hook,130,'Hook',true),
        angle:cleanText(idea.angle,700,'Umsetzung',true),goal:idea.goal,needs:cleanText(idea.needs,500,'Fehlender Kontext')};
    }),limitations:raw.limitations.map(value=>cleanText(value,500,'Grenze',true))};
}
