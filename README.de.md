# FlessingLabs Stundenplan

**Deutsch** · [English](README.md)

Ein Yuvomi-Modul für Unterricht, Betreuung und Nachmittagsprojekte je Kind. Es beantwortet vor allem eine Frage:

**Wo ist mein Kind laut Plan gerade, was kommt danach, und wann kommt es voraussichtlich nach Hause?**

> **Braucht Yuvomi mit Modulspeicher *und* Personen-Freigaben.** Das sind die Migrationen 274 und 275 des FlessingLabs-Forks (Branch [`feat/module-storage`](https://github.com/FlessingLabs/yuvomi/tree/feat/module-storage), Image `ghcr.io/flessinglabs/yuvomi:module-storage-…`, ab dem Stand mit Migration 275). Im offiziellen Yuvomi gibt es beides nicht. Auf einem Yuvomi ohne diese Funktionen zeigt der Stundenplan eine Meldung und speichert nichts, denn ohne serverseitige Trennung wären alle Kinderpläne für alle sichtbar.

Alle Zeiten sind **Planzeiten**. Es gibt kein Standorttracking und keine Ankunftsbestätigung. Nach Ablauf der Zeit behauptet das Modul nicht, das Kind sei zu Hause.

## Was es kann

- **Heute:** eine Karte je Kind mit aktuellem und nächstem Abschnitt, dem letzten Eintrag des Tages und der erwarteten Heimkehr, oder „Heimkehr noch offen“ mit Grund. Abweichungen sind deutlich markiert. Andere Tage lassen sich über die Datumsauswahl ansehen.
- **Woche:** je Kind die Woche mit allen Abschnitten, Lücken und Heimkehrzeiten.
- **Pläne:**
  - Jedes Kind hat eigene Pläne mit Bezeichnung und Gültigkeitszeitraum.
  - Je Wochentag: Unterricht, optionale Betreuung, optionale Projekte (mit Ort) und was danach passiert (nach Hause oder Abholung).
  - Heimwegdauer je Ort.
  - Ferienregel für Betreuung und Projekte.
  - Optional A/B-Wochen.
  - „Wie Montag“ übernimmt einen Tag. „Als neuen Plan kopieren“ dient als Vorlage für das nächste Schuljahr.
- **Abweichung für einen Tag:**
  - schulfrei oder abwesend;
  - Unterricht fällt aus oder endet früher;
  - Betreuung entfällt oder hat andere Zeiten;
  - ein Projekt fällt aus oder wird verschoben;
  - Abholung oder direkt heim;
  - dazu eine Notiz.

  Der Wochenplan bleibt dabei unverändert.

## Wie die Heimkehr berechnet wird

- Grundlage ist der Plan, der an diesem Tag gilt. Gilt keiner, steht „kein Plan“; gelten mehrere, wird die Überschneidung genannt.
- Der **letzte Eintrag** des Tages zählt, nicht die Zahl der Stunden. Danach gilt, was beim Wochentag unter „Danach“ steht:
  - **nach Hause:** Ende des letzten Eintrags plus Heimweg ab dessen Ort;
  - **Abholung:** eine eingetragene Heimkehrzeit, oder Abholzeit plus Fahrtdauer.
- **Heimkehr bleibt offen**, wenn etwas fehlt oder sich widerspricht: Heimwegdauer für den Ort, Abholzeit, Überschneidung, Ende vor Beginn. Ebenso, wenn eine Abweichung etwas absagt, ohne zu sagen, was stattdessen gilt. Fällt etwa Theater aus, berechnet das Modul **keine** frühere Heimkehr; die Abweichung muss „länger Betreuung“ oder „direkt heim“ sagen.
- **Lücken** zwischen Einträgen erscheinen als „keine Angabe“, nie als Betreuung.
- Ein Tag ohne Eintrag heißt „nichts eingetragen“, nicht „schulfrei“.
- **Ferien und Feiertage** kommen aus Yuvomi (Einstellungen → Ferien: Land, Region, „Schulferien zeigen“). An solchen Tagen entfällt Unterricht; Betreuung und Projekte folgen der Ferienregel des Plans (findet statt, entfällt, offen). Fehlen die Ferieninfos oder das Recht auf den Kalender, sagt die Seite das.
- **A/B-Wochen:** Eine A-Woche beginnt am eingetragenen Datum, danach wird in Kalenderwochen abgewechselt. Ferien verschieben den Rhythmus nicht.
- Gerechnet wird in der **Zeitzone des Haushalts** (Yuvomi-Einstellung). Das gilt auch am Tag der Zeitumstellung und auf Geräten in einer anderen Zone.

## Wer was sieht

Die Kinder sind normale Yuvomi-Benutzer; das Modul legt keine eigenen Kinder oder Konten an. Jeder Plan gehört einem Benutzer, und **Yuvomi prüft auf dem Server** bei jedem Zugriff:

| Wer | Pläne eines Kindes |
|---|---|
| Admin | sehen und pflegen |
| Das Kind selbst | sehen |
| Wem ein Admin es für dieses Kind freigegeben hat | sehen oder pflegen |
| Alle anderen | nichts, die Pläne existieren für sie nicht |

Die Freigaben setzt ein Admin unter **Einstellungen → Module → Stundenplan**. Nichts wird aus Rolle, Name oder Alter abgeleitet. Das Modulrecht „Stundenplan“ unter Rollen & Berechtigungen bleibt die äußere Schranke.

Wird ein Kind aus dem Haushalt entfernt, wird es deaktiviert statt gelöscht. Seine Pläne bleiben erhalten und können nie bei jemand anderem landen. Wer entfernt wird, verliert seine Freigaben.

## Installation

1. **Yuvomi mit Modulspeicher** betreiben, also das Fork-Image mit Migration 275. Im Log muss beim Start `Migration 275 applied` stehen. Anleitung für Unraid inkl. Sicherung und Rückweg: [QuickShop – UNRAID-TEST.de.md](https://github.com/FlessingLabs/yuvomi-quickshop/blob/feat/core-storage/docs/UNRAID-TEST.de.md). Das Vorgehen ist dasselbe.
2. Modul installieren, auf einem von zwei Wegen:
   - über Einstellungen → Module → Eigenes Modul hinzufügen (braucht `MODULES_ALLOW_WEB_INSTALL=true`), Adresse
     `https://github.com/FlessingLabs/yuvomi-school/tree/main/module`
   - oder von Hand auf Unraid:
     ```sh
     cd /tmp && rm -rf yuvomi-school-main && curl -sL https://codeload.github.com/FlessingLabs/yuvomi-school/tar.gz/refs/heads/main | tar xz
     cp -r /tmp/yuvomi-school-main/module /mnt/user/appdata/yuvomi/modules/flessinglabs-school
     ```
3. Unter Einstellungen → Module einschalten (bei Installation über die Oberfläche).
4. Unter **Einstellungen → Module → Stundenplan** festlegen, wer die Pläne welches Kindes sehen oder pflegen darf.
5. Unter **Pläne** je Kind einen Plan anlegen.

**Aktualisieren:** dieselben Schritte. Die Pläne liegen in Yuvomis Datenbank und bleiben bei Updates, beim Abschalten und beim Entfernen des Moduls erhalten. Sie sind Teil von Yuvomis Sicherung.

**Modul-ID:** `flessinglabs-school`. Sie ist fest; Repository-Name und Anzeigename dürfen sich unterscheiden.

## Entwicklung und Tests

```sh
npm test    # Tagesberechnung (Abnahmefälle), Speicher-Client, Ferien, Planprüfung, Übersetzungen
node tools/e2e/e2e-school.mjs setup   --base http://127.0.0.1:3000 --user admin --password …   # gegen einen Test-Yuvomi
node tools/e2e/e2e-school.mjs persist --base http://127.0.0.1:3000 --user admin --password …   # nach Neustart
node tools/e2e/e2e-school.mjs readonly --base http://<server>:<port> --user … --password …       # nur lesend
```

Der Abnahmetest legt Testmitglieder mit dem Präfix `e2e` an. Er gehört deshalb auf ein Testsystem, nicht auf die Familieninstallation.

## Nicht enthalten

Standort/GPS, Anwesenheitserkennung, KI, Schulportal-Import, Noten, Chat, automatische Benachrichtigungen, eigene Kinderverwaltung.

## Lizenz

MIT, © 2026 FlessingLabs.
