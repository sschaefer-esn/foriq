#pragma once
#include <Arduino.h>

// Localisation: every page is English by default. Elements carrying data-t="key"
// (innerHTML) or data-tp="key" (placeholder) are replaced from the page's German
// dictionary `D` when the browser language starts with "de". The portal has no
// internet access, so everything is inline. German strings use HTML entities to
// keep this file ASCII. Fragments rendered by wifi_manager.cpp use the same keys.
// Afterwards D is {} for English, so page scripts can use D.key||'English'.
#define PORTAL_I18N_JS \
    "if(/^de/i.test(navigator.language||'')){document.documentElement.lang='de';" \
    "document.querySelectorAll('[data-t]').forEach(function(e){var v=D[e.getAttribute('data-t')];if(v)e.innerHTML=v});" \
    "document.querySelectorAll('[data-tp]').forEach(function(e){var v=D[e.getAttribute('data-tp')];if(v)e.placeholder=v})}else D={};"

// Scan/setup page: %NETWORKS% is replaced with the network list HTML,
// %SERVER% with the stored server URL, %RESET_SECTION% with the reset link.
static const char PORTAL_PAGE[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foriq WiFi Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.c{max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{font-size:1.3em;margin-bottom:4px}
.sub{color:#888;font-size:.85em;margin-bottom:20px}
.net{padding:12px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
.net:hover,.net.sel{border-color:#0066ff;background:#f0f6ff}
.net.hid{display:none}
.chk{display:none;margin-left:8px;color:#0066ff;font-weight:700}
.net.sel .chk{display:inline}
.sig{font-size:.8em;color:#888}
label{display:block;margin-top:16px;font-size:.9em;font-weight:600}
input[type=password],input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:1em;margin-top:6px}
details{margin-top:16px;font-size:.9em}
summary{cursor:pointer;color:#555}
button{width:100%;padding:12px;background:#0066ff;color:#fff;border:none;border-radius:8px;font-size:1em;font-weight:600;margin-top:20px;cursor:pointer}
button:active{background:#0052cc}
button:disabled{background:#99c2ff;cursor:not-allowed}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}
.pwhint{font-size:.8em;color:#888;margin-top:6px}
.reset{display:block;margin-top:24px;text-align:center;font-size:.85em;color:#c00;text-decoration:none}
</style>
</head>
<body>
<div class="c">
<h1>Foriq WiFi Setup</h1>
<p class="sub" data-t="sub">Choose a network and enter its password</p>
<form method="POST" action="/connect">
<div id="nets">%NETWORKS%</div>
<input type="hidden" name="ssid" id="ssid" value="">
<label><span data-t="pw">Password</span>
<input type="password" name="password" id="pw" placeholder="WiFi password" data-tp="pp">
</label>
<div class="pwhint" data-t="ph">Tip: long-press the field, then choose &ldquo;Paste&rdquo;</div>
<details>
<summary data-t="adv">Advanced</summary>
<label>Server (optional)
<input type="text" name="server" value="%SERVER%" placeholder="http://foriq.local:8420" autocapitalize="off" autocorrect="off" spellcheck="false">
</label>
<div class="pwhint" data-t="sh">Leave empty for the Foriq app at foriq.local:8420. Otherwise enter the IP of the Foriq computer, e.g. 192.168.1.20 (port 8420 is added automatically).</div>
</details>
<button type="submit" id="btn" data-t="con">Connect</button>
</form>
%RESET_SECTION%
</div>
<script>
var D={sub:"Netzwerk ausw&auml;hlen und Passwort eingeben",pw:"Passwort",pp:"WLAN-Passwort",
ph:"Tipp: lange ins Feld tippen, dann &bdquo;Einf&uuml;gen&ldquo; w&auml;hlen",adv:"Erweitert",
sh:"Leer lassen f&uuml;r die Foriq-App unter foriq.local:8420. Sonst die IP des Foriq-Rechners, z. B. 192.168.1.20 (Port 8420 wird erg&auml;nzt).",
con:"Verbinden",cg:"Verbinde...",sg:"gut",sm:"mittel",sw:"schwach",nn:"Keine Netzwerke gefunden.",
nr:"Keine Netzwerke gefunden. Seite neu laden.",rl:"Ger&auml;tewechsel (setzt die Anmeldung zur&uuml;ck)"};
)rawliteral" PORTAL_I18N_JS R"rawliteral(
document.querySelector('form').addEventListener('submit',function(){
  var b=document.getElementById('btn');
  b.disabled=true;
  b.innerHTML='<span class="spinner"></span>'+(D.cg||'Connecting...');
});
document.querySelectorAll('.net').forEach(function(el){
  el.addEventListener('click',function(){
    var was=el.classList.contains('sel');
    document.querySelectorAll('.net').forEach(function(n){n.classList.remove('sel');n.classList.remove('hid')});
    if(!was){
      el.classList.add('sel');
      document.querySelectorAll('.net').forEach(function(n){if(n!==el)n.classList.add('hid')});
      document.getElementById('ssid').value=el.dataset.ssid;
      document.getElementById('pw').focus();
    }else{
      document.getElementById('ssid').value='';
    }
  });
});
</script>
</body>
</html>)rawliteral";

// Connecting page: %SSID% is replaced with the escaped SSID.
static const char CONNECTING_PAGE[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3;url=/result">
<title>Foriq WiFi Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.c{max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
h1{font-size:1.3em;margin-bottom:16px}
@keyframes spin{to{transform:rotate(360deg)}}
.sp{display:inline-block;width:32px;height:32px;border:3px solid #0066ff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}
.msg{color:#555;font-size:1em}
</style>
</head>
<body>
<div class="c">
<h1>Foriq WiFi Setup</h1>
<div class="sp"></div>
<div class="msg"><span data-t="cm">Connecting to</span> '%SSID%'...</div>
</div>
<script>var D={cm:"Verbinde mit"};)rawliteral" PORTAL_I18N_JS R"rawliteral(</script>
</body>
</html>)rawliteral";

// Confirmation page for the local reset (activated devices only). The reset
// only clears the sensor; to register it again it must first be deleted in the app.
static const char RESET_CONFIRM_PAGE[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foriq WiFi Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.c{max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{font-size:1.3em;margin-bottom:16px}
.warn{padding:12px;border-radius:8px;background:#fde8e8;color:#c00;font-size:.95em;line-height:1.45}
form{margin-top:20px}
button{width:100%;padding:12px;background:#c00;color:#fff;border:none;border-radius:8px;font-size:1em;font-weight:600;cursor:pointer}
a{display:block;margin-top:16px;padding:12px;background:#e0e0e0;color:#333;border-radius:8px;text-decoration:none;font-weight:600;text-align:center}
</style>
</head>
<body>
<div class="c">
<h1 data-t="rt">Reset local registration?</h1>
<div class="warn" data-t="rw"><b>Are you sure?</b><br>
WiFi settings, the device registration and readings not yet uploaded are deleted
from this sensor. Readings already on the server are kept. To register the sensor
again, delete it in the Foriq app first.</div>
<form method="POST" action="/reset-go">
<button type="submit" data-t="rb">Reset local registration</button>
</form>
<a href="/" data-t="ca">Cancel</a>
</div>
<script>var D={rt:"Lokale Anmeldung zur&uuml;cksetzen?",
rw:"<b>Bist du sicher?</b><br>WLAN, Ger&auml;te-Anmeldung und noch nicht &uuml;bertragene Messdaten werden lokal gel&ouml;scht. Bereits &uuml;bertragene Messdaten bleiben bestehen. Zum erneuten Registrieren den Sensor zuerst in der Foriq-App l&ouml;schen.",
rb:"Lokale Anmeldung zur&uuml;cksetzen",ca:"Abbrechen"};
)rawliteral" PORTAL_I18N_JS R"rawliteral(</script>
</body>
</html>)rawliteral";

// Short status page: %MESSAGE% is replaced (keys rr/rs, see wifi_manager.cpp).
static const char STATUS_PAGE[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foriq WiFi Setup</title>
<style>body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.c{max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
h1{font-size:1.3em;margin-bottom:16px}.msg{color:#555}</style>
</head>
<body><div class="c"><h1>Foriq WiFi Setup</h1><div class="msg">%MESSAGE%</div></div>
<script>var D={rr:"Lokale Anmeldung wird gel&ouml;scht. Das Ger&auml;t startet neu...",rs:"Ger&auml;t wird neu gestartet..."};
)rawliteral" PORTAL_I18N_JS R"rawliteral(</script>
</body>
</html>)rawliteral";

// Result page: %STATUS_CLASS%, %MESSAGE% and %EXTRA% are replaced. The message
// and extra fragments come from wifi_manager.cpp and use the keys below.
static const char RESULT_PAGE[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foriq WiFi Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:20px;color:#333}
.c{max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
h1{font-size:1.3em;margin-bottom:16px}
.msg{padding:12px;border-radius:8px}
.ok{background:#e6f9e6;color:#1a7a1a}
.err{background:#fde8e8;color:#c00}
a{display:inline-block;margin-top:16px;color:#0066ff}
.device-add{margin-top:16px;padding:16px;background:#f7f9fc;border:1px solid #d7deea;border-radius:10px;text-align:left}
.serial-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding:12px;background:#fff;border:1px solid #e0e5ed;border-radius:8px}
.serial-row span{font-size:.85em;color:#666}
.serial-row strong{font-family:monospace;font-size:1.1em;color:#0066ff;word-break:break-all}
.copy-actions{display:grid;gap:8px;margin-top:12px}
.cp{width:100%;padding:11px 12px;background:#0066ff;color:#fff;border:none;border-radius:7px;font-size:.9em;font-weight:600;cursor:pointer}
.cp:active{background:#0052cc}
.cp:focus-visible,.done:focus-visible{outline:3px solid #99c2ff;outline-offset:2px}
.hint{margin-top:12px;font-size:.85em;color:#555;line-height:1.45;text-align:left}
.done{display:block;margin-top:16px;padding:12px;background:#e0e0e0;color:#333;border-radius:8px;text-decoration:none;font-weight:600;font-size:1em;text-align:center}
</style>
</head>
<body>
<div class="c">
<h1>Foriq WiFi Setup</h1>
<div class="msg %STATUS_CLASS%">%MESSAGE%</div>
%EXTRA%
</div>
<script>var D={ns:"Kein Netzwerk ausgew&auml;hlt.",
is:"Ung&uuml;ltige Serveradresse. Nur http:// zu lokalen Adressen (foriq.local, 192.168.x.x), kein https.",
bk:"Zur&uuml;ck",ok:"Verbunden mit",f1:"Verbindung mit",f2:" fehlgeschlagen.",f3:"Passwort pr&uuml;fen und erneut versuchen.",
ah:"<b>Geschafft!</b> Das Ger&auml;t l&auml;uft mit der bestehenden Konfiguration weiter und ist gleich wieder online.",
dn:"Fertig",sn:"Seriennummer:",cs:"Seriennummer kopieren",
nh:"Danach dieses Fenster schlie&szlig;en, vom WLAN <b>Foriq-Setup</b> trennen und den Sensor in der Foriq-App unter <b>Neue Sensoren</b> freigeben.",
fs:"Setup abschlie&szlig;en",cpd:"Kopiert!"};
)rawliteral" PORTAL_I18N_JS R"rawliteral(</script>
</body>
</html>)rawliteral";
