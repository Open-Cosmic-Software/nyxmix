// Klang Faust example: stereo Zita reverb (re.zita_rev1_stereo) with a dry/wet mix.
// Install: POST /api/plugins/faust {"id":"zita-reverb","label":"Zita Reverb","code":<this file>}
import("stdfaust.lib");
predelay = hslider("Predelay [unit:ms]", 40, 0, 200, 1);
lowRt60 = hslider("Low RT60 [unit:s]", 3, 0.5, 8, 0.1);
midRt60 = hslider("Mid RT60 [unit:s]", 2, 0.5, 8, 0.1);
damping = hslider("Damping [unit:Hz]", 6000, 1500, 20000, 1);
wet = hslider("Wet", 0.3, 0, 1, 0.01);
verb = re.zita_rev1_stereo(predelay, 200, damping, lowRt60, midRt60, 96000);
process = _,_ <: (*(1 - wet), *(1 - wet)), (verb : *(wet), *(wet)) :> _,_;
