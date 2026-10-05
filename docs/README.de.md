<div align="center">

# codex session continuity

**Eine gut vorbereitete Übergabe für lange Codex-Aufgaben.**

[English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Deutsch](README.de.md)

![Eine gut vorbereitete Übergabe für lange Codex-Aufgaben.](images/hero.png)

</div>

Ein Windows-Helfer für lokale Verlaufsarchive, Übergabenotizen und die Fortsetzung im selben Projekt. Die neue Aufgabe liest die Notiz und greift bei Bedarf auf Belege zu; nicht die gesamte Unterhaltung wird erneut in den Prompt geladen.

> [!IMPORTANT]
> Experimentelle Vorschau, kein offizielles OpenAI-Produkt. Lokale Schnittstellen der Desktop-App können sich nach Updates ändern. Neue Installationen starten mit pausierter Automatik. Prüfe zuerst das effektive Kontextfenster und die Schwellenwerte.

## Funktionen

![Funktionen](images/overview.png)

| Funktion | Beschreibung |
| --- | --- |
| Verlauf erhalten | Bereits gespeicherte Gespräche und Werkzeugausgaben werden inkrementell archiviert und durchsuchbar indexiert. |
| Übergabe vorbereiten | Der ursprüngliche Assistent dokumentiert Entscheidungen, Fortschritt, Grenzen, Prüfungen und nächste Schritte. |
| Projekt beibehalten | Projekt, Arbeitsverzeichnis und Berechtigungen werden geprüft; Checkout und nicht committete Dateien bleiben erhalten. |
| Anhänge sichern | Unterstützte lokale/eingebettete Anhänge samt Herkunft werden gespeichert. Speicherung bedeutet nicht, dass Inhalte verstanden wurden. |

## Drei Schritte

![Drei Schritte](images/workflow.png)

1. Archivieren: lokale Datensätze und Anhangsverweise im Hintergrund sichern.
2. Vorbereiten: der Quellassistent schreibt HANDOFF.md und antwortet mit einem eindeutigen Bestätigungstoken.
3. Fortsetzen: nach Abschluss des Quell-Turns und bestandenen Prüfungen genau eine neue Aufgabe anlegen.

## Installation unter Windows

Erforderlich sind ein angemeldetes Codex Desktop, Node.js 24+ und PowerShell 7+. Speichere den genauen Arbeitsordner als Projekt in der App. Erstelle eine separate Verwaltungsaufgabe und kopiere UUID oder Link; sie darf nicht die fortzusetzende Aufgabe sein.

Lade ZIP und SHA256SUMS aus Releases, vergleiche SHA-256 und entpacke die Dateien. Öffne PowerShell 7 dort und ersetze den Platzhalter durch die echte UUID der Verwaltungsaufgabe.

[Releases](https://github.com/maiijhcg/codex-session-continuity/releases)

```powershell
pwsh -NoProfile -File .\install.ps1 -OwnerThreadId "PASTE_MANAGEMENT_TASK_UUID" -WithIntegration
```

Standardziel ist `%LOCALAPPDATA%\CodexSessionContinuity`. Der Autostart bei Windows-Anmeldung des aktuellen Benutzers wird standardmäßig eingerichtet: nach Neustart und Anmeldung läuft der Prozess unsichtbar, ohne Administratorrechte. Es ist kein Systemdienst vor der Anmeldung. Neue Installationen pausieren die Automatik; spätere Anmeldungen behalten deine Auswahl bei.

`-NoStartup` verzichtet auf die Autostart-Registrierung, `-NoStart` verschiebt den sofortigen Start. `-InstallDir`/`-CodexHome` legen Ordner fest, `-SoftLimit`/`-HardLimit` die Schwellenwerte. Ohne `-WithIntegration` werden Hook und Hinweise später installiert. Der Hook muss über den normalen Codex-Vertrauensdialog geprüft werden; keine automatische Freigabe.

## Manuelle Bedienung

![Manuelle Bedienung](images/control.png)

| Taste | Aktion |
| --- | --- |
| **1** | Automatische Fortsetzung aktivieren |
| **2** | Automatik pausieren; Archivierung läuft weiter |
| **3** | Prozess, Desktop-Verbindung und Anfragen aktualisieren |
| **4** | Eine Aufgabe ausdrücklich per Nummer, UUID oder vollständigem Link auswählen |
| **5** | Menüsprache auswählen und speichern |
| **0** | Beenden, ohne den Schalter zu ändern |

Prüfe zunächst mit 3 Prozess, aktuellen Heartbeat und Verbindung, dann nutze 1 oder 4. Aktive Aufgaben erscheinen zuerst, anschließend nach letzter Aktivität. Eingereiht ist nicht abgeschlossen; eine wiederholte Auswahl nutzt die vorhandene wartende Anfrage.

Das Menü startet auf Englisch und unterstützt Englisch, traditionelles/vereinfachtes Chinesisch, Japanisch und Spanisch. Die Dokumentation gibt es zusätzlich auf Deutsch, Französisch, Koreanisch und Russisch; diese Menüsprachen sind noch nicht enthalten. Aufgabentitel, Verlauf und technische Rohdiagnosen bleiben in ihrer Ursprungssprache. 5 speichert die Auswahl; `-Language` gilt nur für den aktuellen Aufruf.

```powershell
.\Codex-Session-Continuity.cmd -Language en
pwsh -NoProfile -File .\manual-switch.ps1 -Action Status -Language en -Json
```

## Schwellenwerte und Grenzen

Beispielwerte sind 500.000 (weich) und 920.000 (hart) Tokens; sie passen nicht zu jedem Modell. Die weiche Schwelle muss während ununterbrochener Überwachung von unten überschritten werden. Beim Start/Wiederaufnehmen bereits verpasste Ereignisse werden nicht nachgeholt; die aktuelle harte Schwelle bleibt relevant. Native Kompaktierung kann einen anderen Zähler oder ein kleineres Fenster nutzen. Modellparameter und Kontextkapazität werden nicht geändert.

## Daten und Sicherheit

`archive/`, `notes/`, Laufzeit-`assets/`, SQLite, Konfiguration und Logs enthalten private Daten. Lade sie nicht auf GitHub hoch. Das Werkzeug ergänzt keine Telemetrie und keinen eigenen Cloud-Upload-Client; normale Codex-Nachrichten und Aufgabenerstellungen nutzen weiterhin dein vorhandenes Konto und den Dienst.

Verlauf und Medien werden nicht automatisch gelöscht. Überwache den Speicher und sichere Daten separat. Verschlüsselung, OCR und Audiotranskription sind nicht enthalten; entfernte Anhänge werden nicht heimlich heruntergeladen. Pausieren widerruft keine gesendete Operation; ein gestoppter Prozess archiviert auch keine neuen Daten.

[SECURITY.md](../SECURITY.md)

## Wartezustände und Fehler

`waiting_handoff` wartet auf die Quelle; `soft_expired` wiederholt kein verpasstes weiches Ereignis; nach `checkpoint_interrupted` entscheidest du über eine erneute Auswahl. Bei `checkpoint_uncertain`/`creation_uncertain` zuerst den Ausgang prüfen, nicht blind erneut senden. Abweichende Projekte oder Rechte stoppen den Ablauf, ohne den Ordner zu wechseln oder Berechtigungen zu erhöhen.

```powershell
node .\cli.mjs status
node .\cli.mjs tasks
node .\controller.mjs resolve "PASTE_TASK_UUID"
```

## Start, Update und Entfernung

Führe die folgenden Befehle im installierten Ordner aus. Stoppe vor Updates den Prozess, sichere den gesamten privaten Laufzeitordner und installiere in dasselbe Ziel. Die Deinstallation bewahrt Programm, Einstellungen, Verlauf, Notizen und Anhänge; Codex-Aufgaben werden nicht gelöscht.

```powershell
pwsh -NoProfile -File .\install-startup.ps1
pwsh -NoProfile -File .\install-startup.ps1 -Remove
pwsh -NoProfile -File .\stop.ps1
pwsh -NoProfile -File .\restart.ps1
pwsh -NoProfile -File .\uninstall.ps1
```

[Vollständiger Windows-Leitfaden auf Englisch](WINDOWS.md) · [CHANGELOG](../CHANGELOG.md) · [NOTICE](../NOTICE.md)

Eine öffentliche Lizenz wurde noch nicht gewählt; MIT/GPL werden nicht vorausgesetzt. Siehe NOTICE.md. Die originalen ImageGen-Bilder sind Konzeptillustrationen, keine echten Bildschirmfotos oder Zusicherungen.

## Sprache der Übergabe und vererbte Rechte

Benachrichtigungen an die alte Sitzung und Startanweisungen der neuen unterstützen neun Sprachen: `en`, `zh-Hant`, `zh-Hans`, `ja`, `es`, `fr`, `ko`, `ru`, `de`. Standard ist Englisch beziehungsweise die mit Menüpunkt 5 gespeicherte Sprache. Ergänze bei einer Neuinstallation `-HandoffLanguage de`. Bei einer bestehenden Installation stoppe den Prozess, ergänze `"handoffLanguage": "de"` in `config.json` und starte neu. Updates behalten die Konfiguration; entferne die Eigenschaft, um wieder dem Menü zu folgen. Ein temporäres `-Language` ändert keine Hintergrundmeldungen. Eine Übergabe behält ihre Sprache; Originaltitel, Pfade, Befehle, Rechte und Bestätigungscodes werden nicht übersetzt.

Die neue Sitzung übernimmt automatisch die tatsächlichen Sandbox- und Freigabeeinstellungen der vorherigen Sitzung, nicht globale Vorgaben oder Rechte der Verwaltungsaufgabe. Eine schreibgeschützte Quelle bleibt schreibgeschützt, auch bei globalem Full access. Der reguläre Codex-Vererbungsweg prüft die Quelle vor dem Senden und Schreibumfang, Netzwerk und Profil nach der Erstellung. Eine geänderte Quelle wird neu gelesen; bei unklarem Ergebnis oder Abweichung bleiben ID und Daten erhalten, während der Vorgang stoppt. Keine Rechteerhöhung, globalen Änderungen oder doppelten Aufgaben. Kann eine schreibgeschützte Quelle HANDOFF.md nicht speichern, ist der normale Berechtigungsablauf des Nutzers nötig. Die bisherige lokale Version wird nicht automatisch verändert.

