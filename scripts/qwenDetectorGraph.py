"""Generate the three packaged ONNX graphs for a Qwen3.5 0.8B detector.

Run with the Python onnx package when changing the graph. Each decoder layer uses one
of two graphs. Its verified safetensors supply the external initializers at load time.
"""
import base64
import json
from pathlib import Path

import numpy as np
from onnx import TensorProto, helper, numpy_helper

F32 = TensorProto.FLOAT
WIDTH, HEADS, KEY_DIM = 1024, 16, 128


def value(name, shape):
    return helper.make_tensor_value_info(name, F32, shape)


class Graph:
    def __init__(self, prefix=""):
        self.prefix = prefix
        self.nodes = []
        self.constants = []
        self.weights = {}

    def op(self, op, *inputs, **attrs):
        out = f"{self.prefix}v{len(self.nodes)}"
        self.nodes.append(helper.make_node(op, inputs, [out], name=out if self.prefix else "", **attrs))
        return out

    def const(self, data, dtype=np.int64):
        name = f"c{len(self.constants)}"
        self.constants.append(numpy_helper.from_array(np.asarray(data, dtype=dtype), name))
        return name

    def weight(self, name, shape):
        self.weights[name] = shape
        tensor = TensorProto(name=name, data_type=F32, dims=shape, data_location=TensorProto.EXTERNAL)
        tensor.external_data.add(key="location", value=name)
        tensor.external_data.add(key="length", value=str(4 * int(np.prod(shape))))
        self.constants.append(tensor)
        return name

    def bf(self, x):
        # ORT Web omits the BF16 Cast kernel. Round in FP32 to the spacing of a
        # BF16 value at this exponent (seven fraction bits, ties to even).
        magnitude = self.op("Max", self.op("Abs", x), self.const(np.finfo(np.float32).tiny, np.float32))
        exponent = self.op("Floor", self.op("Mul", self.op("Log", magnitude), self.const(np.log2(np.e), np.float32)))
        spacing = self.op("Pow", self.const(2, np.float32), self.op("Sub", exponent, self.const(7, np.float32)))
        # Some GPUs flush subnormal spacing to zero. On those devices, carry zero
        # through the rounding step without introducing 0/0 into the next layer.
        safe = self.op("Where", self.op("Greater", spacing, self.const(0, np.float32)), spacing, self.const(1, np.float32))
        return self.op("Mul", self.op("Round", self.op("Div", x, safe)), spacing)

    def project(self, x, name, dim_in, dim_out, *, head=False):
        w = self.weight(name + ".weight", [dim_out, dim_in])
        y = self.op("MatMul", x, self.op("Transpose", w))
        return y if head else self.bf(y)

    def norm(self, x, name, dim, *, centered=True):
        w = self.weight(name + ".weight", [dim])
        if centered:
            w = self.op("Add", w, self.const(1, np.float32))
        mean = self.op("ReduceMean", self.op("Mul", x, x), self.const([-1]), keepdims=1)
        rms = self.op("Sqrt", self.op("Add", mean, self.const(1e-6, np.float32)))
        y = self.op("Div", x, rms)
        return self.bf(self.op("Mul", y if centered else self.bf(y), w))

    def reshape(self, x, shape):
        return self.op("Reshape", x, self.const(shape))

    def slice(self, x, start, end, axis=-1):
        return self.op("Slice", x, self.const([start]), self.const([end]), self.const([axis]))

    def silu(self, x):
        return self.bf(self.op("Mul", x, self.op("Sigmoid", x)))

    def finish(self, name, inputs, outputs):
        for node, target, _ in outputs:
            self.nodes.append(helper.make_node("Identity", [node], [target]))
        graph = helper.make_graph(self.nodes, name, inputs, [value(k, shape) for _, k, shape in outputs], self.constants)
        model = helper.make_model(graph, ir_version=9, opset_imports=[helper.make_opsetid("", 20)])
        return dict(model=base64.b64encode(model.SerializeToString()).decode(), weights=self.weights)


def delta_scan_body():
    # One recurrent update, vectorized over heads. The scan itself follows token order.
    g = Graph("delta_")
    state = g.op("Mul", "state", "decay")
    kt = g.op("Transpose", "k", perm=[0, 2, 1])
    update = g.op("Mul", g.op("Sub", "v", g.op("MatMul", "k", state)), "beta")
    new = g.op("Add", state, g.op("MatMul", kt, update))
    out = g.op("MatMul", "q", new)
    state_shape, row = [HEADS, KEY_DIM, KEY_DIM], [HEADS, 1, KEY_DIM]
    return helper.make_graph(g.nodes, "delta_update",
        [value("state", state_shape), value("q", row), value("k", row), value("v", row),
         value("beta", [HEADS, 1, 1]), value("decay", [HEADS, 1, 1])],
        [value(new, state_shape), value(out, row)])


def linear_attention(g, x):
    def proj(key, size):
        return g.project(x, "linear_attn." + key, WIDTH, size)
    projection = proj("in_proj_qkv", 6144)
    # PyTorch Conv1d is a causal, depthwise cross-correlation in this model.
    channels = g.op("Unsqueeze", g.op("Transpose", projection), g.const([0]))
    conv = g.op("Conv", channels, g.weight("linear_attn.conv1d.weight", [6144, 1, 4]),
                kernel_shape=[4], pads=[3, 0], group=6144)
    qkv = g.silu(g.bf(g.op("Transpose", g.op("Squeeze", conv, g.const([0])))))
    q, k, v = [g.reshape(g.slice(qkv, offset, offset + 2048), [-1, HEADS, 1, KEY_DIM])
               for offset in (0, 2048, 4096)]

    def l2(vec):
        square = g.op("ReduceSum", g.op("Mul", vec, vec), g.const([-1]), keepdims=1)
        return g.op("Div", vec, g.op("Sqrt", g.op("Add", square, g.const(1e-6, np.float32))))

    q = g.op("Mul", l2(q), g.const(KEY_DIM ** -0.5, np.float32))
    beta = g.reshape(g.bf(g.op("Sigmoid", proj("in_proj_b", HEADS))), [-1, HEADS, 1, 1])
    a = g.op("Add", proj("in_proj_a", HEADS), g.weight("linear_attn.dt_bias", [HEADS]))
    slope = g.op("Neg", g.op("Exp", g.weight("linear_attn.A_log", [HEADS])))
    decay = g.reshape(g.op("Exp", g.op("Mul", slope, g.op("Softplus", a))), [-1, HEADS, 1, 1])
    zero = g.op("ConstantOfShape", g.const([HEADS, KEY_DIM, KEY_DIM]))
    g.nodes.append(helper.make_node("Scan", [zero, q, l2(k), v, beta, decay], ["final_state", "rows"],
                                    num_scan_inputs=5, body=delta_scan_body()))
    norm = g.norm(g.bf(g.reshape("rows", [-1, HEADS, KEY_DIM])), "linear_attn.norm", KEY_DIM, centered=False)
    gate = g.reshape(proj("in_proj_z", 2048), [-1, HEADS, KEY_DIM])
    gated = g.bf(g.op("Mul", norm, g.op("Mul", gate, g.op("Sigmoid", gate))))
    return g.project(g.reshape(gated, [-1, 2048]), "linear_attn.out_proj", 2048, WIDTH)


def full_attention(g, x):
    def proj(name, size):
        return g.project(x, "self_attn." + name, WIDTH, size)
    # Half of each Q projection is an output gate. Rotate the first 64 components only.
    q_gate = g.reshape(proj("q_proj", 4096), [-1, 8, 512])
    gate = g.reshape(g.slice(q_gate, 256, 512), [-1, 2048])
    q = g.norm(g.slice(q_gate, 0, 256), "self_attn.q_norm", 256)
    k = g.norm(g.reshape(proj("k_proj", 512), [-1, 2, 256]), "self_attn.k_norm", 256)
    v = g.reshape(proj("v_proj", 512), [-1, 2, 256])
    n = g.op("Gather", g.op("Shape", x), g.const(0), axis=0)
    pos = g.op("Range", g.const(0), n, g.const(1))
    angle = g.op("Mul", g.reshape(g.op("Cast", pos, to=F32), [-1, 1, 1]),
                 g.const(10_000_000.0 ** (-np.arange(0, 64, 2) / 64), np.float32))
    cos, sin = [g.bf(g.op(fn, angle)) for fn in ("Cos", "Sin")]

    def rotated(y):
        a, b = g.slice(y, 0, 32), g.slice(y, 32, 64)
        first = g.bf(g.op("Sub", g.bf(g.op("Mul", a, cos)), g.bf(g.op("Mul", b, sin))))
        second = g.bf(g.op("Add", g.bf(g.op("Mul", b, cos)), g.bf(g.op("Mul", a, sin))))
        return g.op("Transpose", g.op("Concat", first, second, g.slice(y, 64, 256), axis=-1), perm=[1, 0, 2])

    repeats = g.const([0, 0, 0, 0, 1, 1, 1, 1])
    k = g.op("Gather", rotated(k), repeats, axis=0)
    v = g.op("Gather", g.op("Transpose", v, perm=[1, 0, 2]), repeats, axis=0)
    logits = g.op("MatMul", rotated(q), g.op("Transpose", k, perm=[0, 2, 1]))
    mask = g.op("LessOrEqual", pos, g.reshape(pos, [-1, 1]))
    masked = g.op("Where", mask, g.op("Mul", logits, g.const(256**-0.5, np.float32)), g.const(-1e30, np.float32))
    attn = g.bf(g.op("MatMul", g.op("Softmax", masked, axis=-1), v))
    flat = g.reshape(g.op("Transpose", attn, perm=[1, 0, 2]), [-1, 2048])
    return g.project(g.bf(g.op("Mul", flat, g.bf(g.op("Sigmoid", gate)))), "self_attn.o_proj", 2048, WIDTH)


def decoder_layer(name, attention):
    g = Graph()
    normalized = g.norm("hidden", "input_layernorm", WIDTH)
    hidden = g.bf(g.op("Add", "hidden", attention(g, normalized)))
    normalized = g.norm(hidden, "post_attention_layernorm", WIDTH)
    gate = g.silu(g.project(normalized, "mlp.gate_proj", WIDTH, 3584))
    up = g.project(normalized, "mlp.up_proj", WIDTH, 3584)
    out = g.project(g.bf(g.op("Mul", gate, up)), "mlp.down_proj", 3584, WIDTH)
    return g.finish(name, [value("hidden", ["tokens", WIDTH])],
                    [(g.bf(g.op("Add", hidden, out)), "result", ["tokens", WIDTH])])


def classification_heads():
    g = Graph()
    hidden = g.norm("hidden", "norm", WIDTH)
    # Callers pass the second copy of the window here; its last token pools the passage.
    pooled = g.op("Gather", hidden, g.const([-1]), axis=0)
    token = g.project(hidden, "token", WIDTH, 3, head=True)
    segment = g.op("Add", g.project(pooled, "segment", WIDTH, 15, head=True), g.weight("segment.bias", [15]))
    mixed = g.op("Add", g.project(pooled, "mixed", WIDTH, 2, head=True), g.weight("mixed.bias", [2]))
    return g.finish("heads", [value("hidden", ["tokens", WIDTH])],
                    [(token, "token", ["tokens", 3]), (segment, "segment", [1, 15]), (mixed, "mixed", [1, 2])])


if __name__ == "__main__":
    # Both runtimes check this contract before applying the packaged layer graphs.
    config = dict(model_type="qwen3_5_text", hidden_size=WIDTH, num_attention_heads=8,
                  num_key_value_heads=2, head_dim=256, linear_num_key_heads=HEADS, linear_num_value_heads=HEADS,
                  linear_key_head_dim=KEY_DIM, linear_value_head_dim=KEY_DIM, linear_conv_kernel_dim=4,
                  intermediate_size=3584, hidden_act="silu", rms_norm_eps=1e-6, attention_bias=False, attn_output_gate=True)
    rope = dict(rope_type="default", rope_theta=10_000_000, partial_rotary_factor=0.25)
    graphs = {"config": config, "rope": rope, "linear_attention": decoder_layer("linear_attention", linear_attention),
              "full_attention": decoder_layer("full_attention", full_attention), "heads": classification_heads()}
    # Scan's CPU kernel iterates one token at a time. Keep its small state updates on
    # that provider so each iteration can reuse the state without a GPU round trip.
    graphs["linear_attention"]["scanNodes"] = [node.name for node in delta_scan_body().node]
    dest = Path(__file__).resolve().parents[1] / "anagramd" / "qwen-graphs.json"
    dest.write_text(json.dumps(graphs, separators=(",", ":")) + "\n")
