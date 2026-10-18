// Example Klang plugin: a fuzz with tone control. Install with
//   curl -X POST $KLANG/api/plugins -H 'Content-Type: application/json' \
//     -d "{\"manifest\": $(cat examples/plugins/fuzz.json), \"code\": $(node -p 'JSON.stringify(require("fs").readFileSync("examples/plugins/fuzz.js","utf8"))')}"
// The processor name must be "plugin-<manifest id>", with one k-rate AudioParam per manifest param.
/* global registerProcessor, AudioWorkletProcessor, sampleRate */
class Fuzz extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 18, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 4000, minValue: 500, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.z = [0, 0]; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const g = Math.pow(10, p.drive[0] / 20), mix = p.mix[0];
    const a = Math.exp((-2 * Math.PI * p.tone[0]) / sampleRate);
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], y = out[c];
      if (!x) { y.fill(0); continue; }
      for (let i = 0; i < y.length; i++) {
        const d = Math.sign(x[i]) * (1 - Math.exp(-Math.abs(x[i] * g)));
        this.z[c] = (1 - a) * d + a * this.z[c];
        y[i] = (1 - mix) * x[i] + mix * this.z[c] * 0.5;
      }
    }
    return true;
  }
}
registerProcessor('plugin-fuzz', Fuzz);
