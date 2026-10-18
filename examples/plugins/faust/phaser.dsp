// Klang Faust example: stereo phaser (pf.phaser2_stereo, 4 notches).
// Install: POST /api/plugins/faust {"id":"faust-phaser","label":"Faust Phaser","code":<this file>}
import("stdfaust.lib");
rate = hslider("Rate [unit:Hz]", 0.5, 0.05, 8, 0.01);
depth = hslider("Depth", 1, 0, 1, 0.01);
feedback = hslider("Feedback", 0.5, -0.99, 0.99, 0.01);
width = hslider("Notch Width [unit:Hz]", 1000, 50, 5000, 1);
minFreq = hslider("Min Freq [unit:Hz]", 100, 20, 5000, 1);
maxFreq = hslider("Max Freq [unit:Hz]", 800, 100, 10000, 1);
process = pf.phaser2_stereo(4, width, minFreq, 1.5, maxFreq, rate, depth, feedback, 0);
