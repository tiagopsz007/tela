// Cancelador de eco para o áudio do sistema capturado na tela.
// Problema: no Windows 10 antigo o Chromium não consegue excluir o áudio do próprio app da captura,
// então a voz do amigo (tocada pelo app) volta misturada no áudio compartilhado.
// Solução: filtro adaptativo (PBFDAF, NLMS em blocos no domínio da frequência) que usa a voz recebida
// como referência e subtrai do áudio capturado a parte que é "cópia" dela. O resto (jogo, música) passa intacto.

class EchoCanceller {
  constructor({ B = 128, P = 64, channels = 2, mu = 0.06, muStart = 0.5, constrainAll = false, gate = 1e-3, reg = 0.2 } = {}) {
    this.constrainAll = constrainAll; this.gate = gate; this.reg = reg;
    this.B = B; this.N = 2 * B; this.K = B + 1; this.P = P; this.C = channels;
    this.mu = mu; this.muStart = muStart;
    this.fft = EchoCanceller.makeFft(this.N);
    this.xPrev = new Float64Array(B);
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.Xre = []; this.Xim = [];
    for (let p = 0; p < P; p++) { this.Xre.push(new Float64Array(this.K)); this.Xim.push(new Float64Array(this.K)); }
    this.head = 0;
    this.S = new Float64Array(this.K);
    this.Wre = []; this.Wim = [];
    for (let c = 0; c < channels; c++) {
      const wr = [], wi = [];
      for (let p = 0; p < P; p++) { wr.push(new Float64Array(this.K)); wi.push(new Float64Array(this.K)); }
      this.Wre.push(wr); this.Wim.push(wi);
    }
    this.yre = new Float64Array(this.K); this.yim = new Float64Array(this.K);
    this.ere = new Float64Array(this.K); this.eim = new Float64Array(this.K);
    this.e = new Float64Array(B);
    this.px = 0;          // potência recente da referência
    this.active = 0;      // blocos com voz de referência ativa (controla o passo de adaptação)
    this.constrainIdx = 0;
  }

  static makeFft(n) {
    const levels = Math.round(Math.log2(n));
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
    return function fft(re, im, inverse) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const wr = cos[k], wi = inverse ? sin[k] : -sin[k];
            const l = j + half;
            const tr = re[l] * wr - im[l] * wi, ti = re[l] * wi + im[l] * wr;
            re[l] = re[j] - tr; im[l] = im[j] - ti;
            re[j] += tr; im[j] += ti;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };
  }

  // x: referência (B amostras, mono). ds: [canal][B] áudio capturado. outs: [canal][B] áudio limpo.
  process(x, ds, outs) {
    const { B, N, K, P, re, im, S } = this;

    // Espectro do bloco atual da referência (overlap-save: bloco anterior + atual)
    for (let i = 0; i < B; i++) { re[i] = this.xPrev[i]; re[B + i] = x[i]; im[i] = 0; im[B + i] = 0; this.xPrev[i] = x[i]; }
    this.fft(re, im, false);
    this.head = (this.head + 1) % P;
    this.Xre[this.head].set(re.subarray(0, K));
    this.Xim[this.head].set(im.subarray(0, K));

    let px = 0;
    for (let i = 0; i < B; i++) px += x[i] * x[i];
    px /= B;
    this.px = 0.8 * this.px + 0.2 * px;
    const adapt = this.px > this.gate && px > this.gate * 0.25; // só aprende quando há voz clara sendo tocada
    if (adapt) this.active++;
    // Passo grande no começo (convergência rápida), depois pequeno (pouco ruído residual)
    const warm = Math.exp(-this.active / 600);
    const mu = this.mu + (this.muStart - this.mu) * warm;

    S.fill(0);
    for (let p = 0; p < P; p++) {
      const xr = this.Xre[p], xi = this.Xim[p];
      for (let k = 0; k < K; k++) S[k] += xr[k] * xr[k] + xi[k] * xi[k];
    }
    // Regularização proporcional à potência média da referência: evita passos enormes nas bordas das palavras
    let sMean = 0;
    for (let k = 0; k < K; k++) sMean += S[k];
    sMean /= K;
    const delta = 1e-3 + this.reg * sMean;

    for (let c = 0; c < this.C; c++) {
      const d = ds[c], out = outs[c], Wr = this.Wre[c], Wi = this.Wim[c];
      const yre = this.yre, yim = this.yim;
      yre.fill(0); yim.fill(0);
      for (let p = 0; p < P; p++) {
        const idx = (this.head - p + P) % P;
        const xr = this.Xre[idx], xi = this.Xim[idx], wr = Wr[p], wi = Wi[p];
        for (let k = 0; k < K; k++) {
          yre[k] += wr[k] * xr[k] - wi[k] * xi[k];
          yim[k] += wr[k] * xi[k] + wi[k] * xr[k];
        }
      }
      this._ifftHalf(yre, yim);
      for (let i = 0; i < B; i++) { const e = d[i] - re[B + i]; this.e[i] = e; out[i] = e; }

      if (!adapt) continue;

      for (let i = 0; i < B; i++) { re[i] = 0; im[i] = 0; re[B + i] = this.e[i]; im[B + i] = 0; }
      this.fft(re, im, false);
      const er = this.ere, ei = this.eim;
      for (let k = 0; k < K; k++) { er[k] = re[k]; ei[k] = im[k]; }

      for (let p = 0; p < P; p++) {
        const idx = (this.head - p + P) % P;
        const xr = this.Xre[idx], xi = this.Xim[idx], wr = Wr[p], wi = Wi[p];
        for (let k = 0; k < K; k++) {
          const g = mu / (S[k] + delta);
          wr[k] += g * (xr[k] * er[k] + xi[k] * ei[k]);
          wi[k] += g * (xr[k] * ei[k] - xi[k] * er[k]);
        }
      }
      // Restrição do gradiente (mantém cada partição com suporte de B amostras)
      const list = this.constrainAll ? Array.from({ length: P }, (_, i) => i) : [this.constrainIdx % P];
      for (const pc of list) {
        const wr = Wr[pc], wi = Wi[pc];
        for (let k = 0; k < K; k++) { re[k] = wr[k]; im[k] = wi[k]; }
        this._mirror();
        this.fft(re, im, true);
        for (let i = B; i < N; i++) { re[i] = 0; im[i] = 0; }
        this.fft(re, im, false);
        for (let k = 0; k < K; k++) { wr[k] = re[k]; wi[k] = im[k]; }
      }
    }
    this.constrainIdx++;
  }

  _mirror() {
    const { re, im, N, B } = this;
    im[0] = 0; im[B] = 0;
    for (let k = 1; k < B; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  }

  _ifftHalf(sre, sim) {
    const { re, im, K } = this;
    for (let k = 0; k < K; k++) { re[k] = sre[k]; im[k] = sim[k]; }
    this._mirror();
    this.fft(re, im, true);
  }
}

if (typeof registerProcessor === 'function') {
  class EchoCancellerProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.B = 128;
      this.aec = new EchoCanceller({ B: this.B, P: 64, channels: 2 });
      this.ref = new Float64Array(this.B);
      this.d = [new Float64Array(this.B), new Float64Array(this.B)];
      this.o = [new Float64Array(this.B), new Float64Array(this.B)];
    }
    process(inputs, outputs) {
      const sys = inputs[0], ref = inputs[1], out = outputs[0];
      if (!out || out.length === 0) return true;
      const B = this.B;
      if (!sys || sys.length === 0) return true; // sem áudio do sistema neste instante: saída em silêncio
      if (sys[0].length !== B) { // tamanho de bloco inesperado: deixa passar sem processar
        for (let c = 0; c < out.length; c++) out[c].set(sys[Math.min(c, sys.length - 1)]);
        return true;
      }
      // referência em mono
      this.ref.fill(0);
      if (ref && ref.length) {
        for (let c = 0; c < ref.length; c++) for (let i = 0; i < B; i++) this.ref[i] += ref[c][i] / ref.length;
      }
      for (let c = 0; c < 2; c++) this.d[c].set(sys[Math.min(c, sys.length - 1)]);
      this.aec.process(this.ref, this.d, this.o);
      for (let c = 0; c < out.length; c++) {
        const src = this.o[Math.min(c, 1)];
        for (let i = 0; i < B; i++) out[c][i] = src[i];
      }
      return true;
    }
  }
  registerProcessor('echo-canceller', EchoCancellerProcessor);
}

if (typeof module !== 'undefined') module.exports = { EchoCanceller };
