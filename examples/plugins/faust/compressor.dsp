// Klang Faust example: stereo-linked compressor (co.compressor_stereo) with makeup gain.
// Install: POST /api/plugins/faust {"id":"faust-comp","label":"Faust Compressor","code":<this file>}
import("stdfaust.lib");
ratio = hslider("Ratio", 4, 1, 20, 0.1);
threshold = hslider("Threshold [unit:dB]", -20, -60, 0, 0.1);
attack = hslider("Attack [unit:ms]", 10, 0.1, 100, 0.1) / 1000;
release = hslider("Release [unit:ms]", 120, 5, 1000, 1) / 1000;
makeup = hslider("Makeup [unit:dB]", 0, 0, 24, 0.1) : ba.db2linear;
process = co.compressor_stereo(ratio, threshold, attack, release) : *(makeup), *(makeup);
