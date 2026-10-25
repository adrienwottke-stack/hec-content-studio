const freeze = value => {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};

export const styleProfiles = freeze([
  {
    id: 'standard',
    label: 'Standard',
    description: 'Bestehender Reel-Stil mit einem passenden Einstieg, sichtbarer Handlung und optionalem Hook-Text.',
    targetSeconds: { min: 15, max: 45 },
    shotSeconds: { min: 0.8, max: 7 },
    render: { showHook: true, normalizeAudio: true, audioFadeSeconds: 0, musicGainDb: -24 },
    instructions: [
      'Den bisherigen Reel-Ablauf verwenden und Kontext, tatsächliche Bilder, Originalton und vorhandene Profilwünsche zusammen berücksichtigen.',
      'Einen nachvollziehbaren Einstieg und passende Abwechslung aus belegten Quellenmomenten wählen; Reichweite und Zuschauerreaktionen bleiben unbestätigte Hypothesen.'
    ]
  },
  {
    id: 'late-night-drive',
    label: 'Late Night Drive',
    description: 'Ruhiger Mitfahrmoment · etwa 20–35 Sekunden · natürliche Nachtfarben · Originalton · kein Text im Film. Die genaue Länge folgt aus dem Material.',
    targetSeconds: { min: 20, max: 35 },
    shotSeconds: { min: 3, max: 7 },
    render: { showHook: false, normalizeAudio: false, audioFadeSeconds: 0.04, musicGainDb: -24 },
    instructions: [
      'Einen ruhigen persönlichen Mitfahrmoment aus den tatsächlich vorhandenen Aufnahmen entwickeln; keine aggressive Actionmontage und keine erfundene Fahrtgeschichte.',
      'Für Bildinhalt, Bewegung, Licht, Stabilität und hörbaren Originalton belegte Fundstellen mit Quelldatei und In-/Out-Timecodes verwenden. Wiederholungen und technisch unbrauchbare Abschnitte aussortieren.',
      'Zunächst etwa 20–35 Sekunden prüfen und die konkrete Länge aus tragfähigen Momenten ableiten. Einstellungen überwiegend 3–7 Sekunden stehen lassen und einfache Schnitte verwenden.',
      'Mit einem visuell starken ruhigen Moment beginnen. Bei Querformat den sinnvollen Hochformatausschnitt anhand der tatsächlichen Bilder prüfen und dokumentieren.',
      'Natürliche Nachtfarben und vorhandene Instrumentenbeleuchtung erhalten. Schatten nicht pauschal aufhellen; übermäßige Sättigung, Schärfung und aufwendige Effekte vermeiden.',
      'Charakteristischen Originalton gezielt erhalten. Nur eine vorhandene eigene Musikdatei dezent darunterlegen; ohne geeignete Datei mit Originalton arbeiten. Keine Musikrechte oder hörbaren Ereignisse unterstellen.',
      'Keine künstlichen Motorgeräusche, Sprachuntertitel, Text-Hooks oder Motivationssprüche automatisch einfügen.',
      'Den tatsächlichen Export kritisch auf Einstieg, Rhythmus, Wiederholungen, Ausschnitt, Übergänge, Farbe und Ton prüfen. Technische Prüfung und ästhetische Einschätzung mit ihren jeweiligen Grenzen kennzeichnen.'
    ]
  }
]);

export function getStyleProfile(value = 'standard') {
  const profile = typeof value === 'string' && styleProfiles.find(item => item.id === value);
  if (!profile) throw Object.assign(new Error('Stilprofil ist ungültig. Bitte Standard oder Late Night Drive wählen.'), { status: 400 });
  return profile;
}
