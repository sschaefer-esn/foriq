// German translations of the backend's English API error messages (`detail`).
// The frontend looks up the exact English string and falls back to English.
// Keys containing {name} placeholders are templates for interpolated messages:
// each placeholder matches any text and is copied into the German sentence.
// Keep the keys identical to the strings in webapp/backend; device-facing and
// external-API (ERP) errors are intentionally not listed.
const messages = {
  // auth / session
  "Not authenticated": "Nicht authentifiziert",
  "Invalid token": "Ungültiger Token",
  "Permission denied": "Keine Berechtigung",
  "Invalid credentials": "Ungültige Anmeldedaten",
  "Password must be at least 8 characters": "Passwort muss mindestens 8 Zeichen haben",
  "Password must be at most 72 bytes": "Passwort darf höchstens 72 Byte lang sein",
  "Current password is incorrect": "Aktuelles Passwort ist falsch",
  "Foriq is already set up. New users are created by the admin.":
    "Foriq ist bereits eingerichtet. Neue Benutzer legt der Admin an.",
  "Username missing": "Benutzername fehlt",
  "Username too long": "Benutzername zu lang",

  // company / account
  "Only the owner can rename the company": "Nur der Besitzer kann die Firma umbenennen",
  "Invalid time zone": "Ungültige Zeitzone",
  "Company not found": "Firma nicht gefunden",
  "Only the owner can delete the company": "Nur der Owner kann die Firma löschen",
  "Only the owner can delete the company and account together":
    "Nur der Owner kann Firma und Account gemeinsam löschen",
  "The account still owns at least one company. Delete it first, or delete the active company together with the account.":
    "Der Account besitzt noch mindestens eine Firma. Löschen Sie diese zuerst oder löschen Sie die aktive Firma zusammen mit dem Account.",
  "The account still owns another company. Delete or transfer it first.":
    "Der Account besitzt noch eine weitere Firma. Löschen oder übertragen Sie diese zuerst.",

  // users
  "Role must be 'admin' or 'viewer'": "Rolle muss 'admin' oder 'viewer' sein",
  "Name missing": "Name fehlt",
  "Username is already taken": "Benutzername ist bereits vergeben",
  "Change your own password under Account": "Eigenes Passwort bitte unter Konto ändern",
  "Member not found": "Mitglied nicht gefunden",
  "Owner role cannot be changed": "Owner-Rolle kann nicht geändert werden",
  "Owner cannot be removed": "Owner kann nicht entfernt werden",
  "Admins cannot remove other admins": "Admins können keine anderen Admins entfernen",
  "No membership found": "Keine Mitgliedschaft gefunden",
  "The owner cannot leave the company": "Owner kann die Firma nicht verlassen",

  // devices
  "Device not found": "Gerät nicht gefunden",
  "No pending device found": "Kein wartendes Gerät gefunden",
  "Device is already activated": "Gerät ist bereits aktiviert",
  "A device with this name already exists": "Ein Gerät mit diesem Namen existiert bereits",
  "No changes specified": "Keine Änderungen angegeben",
  "Production counter is already running": "Produktionszähler läuft bereits",
  "No production counter running": "Kein laufender Produktionszähler",
  "Source machine not found": "Quellmaschine nicht gefunden",
  "One or more target machines were not found": "Eine oder mehrere Zielmaschinen wurden nicht gefunden",
  "No owner set up yet": "Noch kein Owner eingerichtet",

  // device validation (Pydantic messages; FastAPI prefixes them with "Value error, ")
  "Name must be 1 to 255 characters long": "Name muss 1 bis 255 Zeichen lang sein",
  "Sensitivity must be between 0.03 g and 0.80 g": "Empfindlichkeit muss zwischen 0,03 g und 0,80 g liegen",
  "Stroke period must be between 400 and 6000 ms": "Hubperiode muss zwischen 400 und 6000 ms liegen",
  "At least one day must be selected": "Mindestens ein Tag muss ausgewählt sein",
  "Days must be between 1 (Mon) and 7 (Sun)": "Tage müssen zwischen 1 (Mo) und 7 (So) liegen",
  "Time must be in HH:MM format": "Zeit muss im Format HH:MM sein",
  "Invalid time of day": "Ungültige Uhrzeit",
  "Time zone (tz) missing": "Zeitzone (tz) fehlt",
  "Select at least one target machine": "Mindestens eine Zielmaschine auswählen",
  "Select at most 200 target machines": "Maximal 200 Zielmaschinen auswählen",
  "The source machine must not be selected as a target": "Die Quellmaschine darf nicht als Ziel ausgewählt sein",
  "Counts must be whole numbers": "Stückzahlen müssen ganze Zahlen sein",
  "Target quantity must be between 1 and 1,000,000,000": "Sollmenge muss zwischen 1 und 1.000.000.000 liegen",
  "Material quantity must be between 0 and 1,000,000,000": "Materialmenge muss zwischen 0 und 1.000.000.000 liegen",
  "Invalid serial number": "Ungültige Seriennummer",
  "Activation code must consist of three hyphen-separated words or a 12-character legacy code":
    "Aktivierungscode muss aus drei Wörtern mit Bindestrichen oder aus einem 12-stelligen Legacy-Code bestehen",

  // commands / OTA
  "Hardware target unknown; update blocked for safety":
    "Hardware-Target unbekannt; Update aus Sicherheitsgründen blockiert",
  "No firmware available on the server": "Keine Firmware auf dem Server verfügbar",
  "Update already in progress": "Update läuft bereits",
  "No active update found": "Kein aktives Update gefunden",

  // data / dashboard
  "Invalid date": "Ungültiges Datum",
  "Invalid date (expected YYYY-MM-DD)": "Ungültiges Datum (YYYY-MM-DD erwartet)",
  "period must be 'week' or 'month'": "period muss 'week' oder 'month' sein",

  // layouts
  "Layout not found": "Layout nicht gefunden",
  "Invalid devices in layout": "Ungültige Geräte im Layout",

  // export
  "Mode must be 'single' or 'multi'": "Modus muss 'single' oder 'multi' sein",
  "Invalid date format (YYYY-MM-DD)": "Ungültiges Datumsformat (YYYY-MM-DD)",
  "End date must be after start date": "Enddatum muss nach Startdatum liegen",
  "At most 1 year can be exported": "Maximal 1 Jahr exportierbar",
  "Select at least one device": "Mindestens ein Gerät auswählen",
  "At most {max} devices can be selected per export": "Maximal {max} Geräte pro Export auswählbar",
  "Unknown format: {format}": "Unbekanntes Format: {format}",
  "Too many records ({total}) for {format}. At most {limit} per export - please shorten the time range or select fewer devices.":
    "Zu viele Datensätze ({total}) für {format}. Maximal {limit} pro Export – bitte Zeitraum verkürzen oder weniger Geräte wählen.",
  "No devices found": "Keine Geräte gefunden",

  // notifications
  "Start and end must not be equal": "Start und Ende dürfen nicht gleich sein",
  "Time windows must not overlap": "Zeitfenster dürfen sich nicht überschneiden",
  "At least one time window is required": "Mindestens ein Zeitfenster ist erforderlich",
  "Work and idle duration together must be shorter than every time window":
    "Arbeits- und Pausendauer müssen zusammen kürzer als jedes Zeitfenster sein",
  "The downtime duration must be shorter than every time window":
    "Die Stillstandsdauer muss kürzer als jedes Zeitfenster sein",
  "At least one machine was not found": "Mindestens eine Maschine wurde nicht gefunden",
  "At least one machine is already assigned": "Mindestens eine Maschine ist bereits zugeordnet",
  "{device} already belongs to rule {rule}": "{device} gehört bereits zur Regel {rule}",
  "Notification rule not found": "Benachrichtigungsregel nicht gefunden",
  "Alert not found": "Meldung nicht gefunden",
  "Weekdays must be between 1 and 7": "Wochentage müssen zwischen 1 und 7 liegen",
  "Name must not be empty": "Name darf nicht leer sein",
  "Machines must not be selected twice": "Maschinen dürfen nicht doppelt ausgewählt werden",

  // API keys (settings UI)
  "API_KEY_HMAC_KEY is not set": "API_KEY_HMAC_KEY ist nicht gesetzt",
  "External API is not enabled for this company": "Externe API ist für diese Firma nicht freigeschaltet",
  "API key not found": "API-Key nicht gefunden",
};

export default messages;
