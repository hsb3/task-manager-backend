#!/usr/bin/env bun
/**
 * Unit-pin scripts/_argparse.ts against Python argparse: the same fixture parser was built
 * in CPython 3.14 (COLUMNS=80, prog "test_argparse.ts") and its stdout, stderr and exit
 * status on each argv below were pasted here, not written by hand.
 */

import { parse_args } from "../scripts/_argparse.ts";
import { py_repr } from "../scripts/_py.ts";

const USAGE = "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name";
const HELP =
  "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n";

// [argv, stdout, stderr, exit status]
const CASES: [string[], string, string, number][] = [
  [
    [],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["-h"],
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n",
    "",
    0,
  ],
  [
    ["--he"],
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n",
    "",
    0,
  ],
  [
    ["-hx"],
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n",
    "",
    0,
  ],
  [
    ["-h=x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -h/--help: ignored explicit argument 'x'\n",
    2,
  ],
  [
    ["--help=x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -h/--help: ignored explicit argument 'x'\n",
    2,
  ],
  [
    ["-x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [["extra"], "{'flag': False, 'opt': None, 'option_two': None, 'name': 'extra'}\n", "", 0],
  [["-1"], "{'flag': False, 'opt': None, 'option_two': None, 'name': '-1'}\n", "", 0],
  [
    ["--flag"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["--fl"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["--opt", "v"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["--opt=v"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["--opt"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -o/--opt: expected one argument\n",
    2,
  ],
  [
    ["--op", "v"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: ambiguous option: --op could match --opt, --option-two\n",
    2,
  ],
  [
    ["a", "b"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: b\n",
    2,
  ],
  [
    ["n", "--fl=x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -f/--flag: ignored explicit argument 'x'\n",
    2,
  ],
  [["n", "-o", "v"], "{'flag': False, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "-ov"], "{'flag': False, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "-o=v"], "{'flag': False, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "-fo", "v"], "{'flag': True, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
  [
    ["n", "-fx"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: -x\n",
    2,
  ],
  [
    ["n", "-f=x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -f/--flag: ignored explicit argument 'x'\n",
    2,
  ],
  [
    ["n", "--opt", "-x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -o/--opt: expected one argument\n",
    2,
  ],
  [["n", "--opt", "-1"], "{'flag': False, 'opt': '-1', 'option_two': None, 'name': 'n'}\n", "", 0],
  [
    ["-x", "-h"],
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n",
    "",
    0,
  ],
  [
    ["--bogus", "extra"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: --bogus\n",
    2,
  ],
  [
    ["--he=x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -h/--help: ignored explicit argument 'x'\n",
    2,
  ],
  [["n", "--opt="], "{'flag': False, 'opt': '', 'option_two': None, 'name': 'n'}\n", "", 0],
  [
    ["n", "-o"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: argument -o/--opt: expected one argument\n",
    2,
  ],
  [
    ["n", "--option-two", "a", "--option-t=b"],
    "{'flag': False, 'opt': None, 'option_two': ['a', 'b'], 'name': 'n'}\n",
    "",
    0,
  ],
  [
    ["n", "--opt", "a b"],
    "{'flag': False, 'opt': 'a b', 'option_two': None, 'name': 'n'}\n",
    "",
    0,
  ],
  [
    ["--x y", "n"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: n\n",
    2,
  ],
  [
    ["n", "-"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: -\n",
    2,
  ],
  [
    ["-fh"],
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\n\nFixture parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -f, --flag            a switch\n  -o, --opt OPT         takes a value\n  --option-two OPTION_TWO\n                        repeatable\n",
    "",
    0,
  ],
  [
    ["n", "--flag", "--flag", "-ff"],
    "{'flag': True, 'opt': None, 'option_two': None, 'name': 'n'}\n",
    "",
    0,
  ],
  [
    ["n", "-x"],
    "",
    "usage: test_argparse.ts [-h] [-f] [-o OPT] [--option-two OPTION_TWO] name\ntest_argparse.ts: error: unrecognized arguments: -x\n",
    2,
  ],
  [["n", "--flag"], "{'flag': True, 'opt': None, 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "--fl"], "{'flag': True, 'opt': None, 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "--opt", "v"], "{'flag': False, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
  [["n", "--opt=v"], "{'flag': False, 'opt': 'v', 'option_two': None, 'name': 'n'}\n", "", 0],
];

// Group fixture: `p.add_mutually_exclusive_group(required=R)` over two store_true flags,
// generated the same way (CPython 3.14, COLUMNS=80).
const GROUP_USAGE = "usage: test_argparse.ts [-h] (--tool-input | --staged)";
const GROUP_HELP =
  "usage: test_argparse.ts [-h] (--tool-input | --staged)\n\nFixture group parser for scripts/_argparse.ts.\n\noptions:\n  -h, --help    show this help message and exit\n  --tool-input  first member\n  --staged      second member\n";
const GROUP_USAGE_OPT = "usage: test_argparse.ts [-h] [--tool-input | --staged]";
const GROUP_HELP_OPT =
  "usage: test_argparse.ts [-h] [--tool-input | --staged]\n\nFixture group parser for scripts/_argparse.ts.\n\noptions:\n  -h, --help    show this help message and exit\n  --tool-input  first member\n  --staged      second member\n";
const GROUP_REQUIRED: [string[], string, string, number][] = [
  [
    [],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: one of the arguments --tool-input --staged is required\n",
    2,
  ],
  [["--tool-input"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [["--staged"], "{'tool_input': False, 'staged': True}\n", "", 0],
  [
    ["--tool-input", "--staged"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["--staged", "--tool-input"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
  [["--tool-input", "--tool-input"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [
    ["--tool-input", "--staged", "-h"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["-h", "--tool-input", "--staged"],
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\n\nFixture group parser for scripts/_argparse.ts.\n\noptions:\n  -h, --help    show this help message and exit\n  --tool-input  first member\n  --staged      second member\n",
    "",
    0,
  ],
  [
    ["--tool-input", "extra"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: unrecognized arguments: extra\n",
    2,
  ],
  [
    ["extra"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: one of the arguments --tool-input --staged is required\n",
    2,
  ],
  [
    ["-x"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: one of the arguments --tool-input --staged is required\n",
    2,
  ],
  [["--t"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [["--s"], "{'tool_input': False, 'staged': True}\n", "", 0],
  [
    ["--t", "--s"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["--staged", "--tool-input", "extra"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
  [
    ["--staged", "--bogus", "--tool-input"],
    "",
    "usage: test_argparse.ts [-h] (--tool-input | --staged)\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
];
const GROUP_OPTIONAL: [string[], string, string, number][] = [
  [[], "{'tool_input': False, 'staged': False}\n", "", 0],
  [["--tool-input"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [["--staged"], "{'tool_input': False, 'staged': True}\n", "", 0],
  [
    ["--tool-input", "--staged"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["--staged", "--tool-input"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
  [["--tool-input", "--tool-input"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [
    ["--tool-input", "--staged", "-h"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["-h", "--tool-input", "--staged"],
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\n\nFixture group parser for scripts/_argparse.ts.\n\noptions:\n  -h, --help    show this help message and exit\n  --tool-input  first member\n  --staged      second member\n",
    "",
    0,
  ],
  [
    ["--tool-input", "extra"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: unrecognized arguments: extra\n",
    2,
  ],
  [
    ["extra"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: unrecognized arguments: extra\n",
    2,
  ],
  [
    ["-x"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: unrecognized arguments: -x\n",
    2,
  ],
  [["--t"], "{'tool_input': True, 'staged': False}\n", "", 0],
  [["--s"], "{'tool_input': False, 'staged': True}\n", "", 0],
  [
    ["--t", "--s"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --staged: not allowed with argument --tool-input\n",
    2,
  ],
  [
    ["--staged", "--tool-input", "extra"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
  [
    ["--staged", "--bogus", "--tool-input"],
    "",
    "usage: test_argparse.ts [-h] [--tool-input | --staged]\ntest_argparse.ts: error: argument --tool-input: not allowed with argument --staged\n",
    2,
  ],
];

// Required-option fixture: `-w/--workspace` (required), positional `name`, `--to`
// (required), `--yes` store_true, declared in that order.
const REQ_USAGE = "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name";
const REQ_HELP =
  "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\n\nFixture required-option parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -w, --workspace WORKSPACE\n                        first required\n  --to TO               second required\n  --yes                 a switch\n";
const REQUIRED_OPTIONS: [string[], string, string, number][] = [
  [
    [],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: -w/--workspace, name, --to\n",
    2,
  ],
  [
    ["-h"],
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\n\nFixture required-option parser for scripts/_argparse.ts.\n\npositional arguments:\n  name                  one positional\n\noptions:\n  -h, --help            show this help message and exit\n  -w, --workspace WORKSPACE\n                        first required\n  --to TO               second required\n  --yes                 a switch\n",
    "",
    0,
  ],
  [
    ["x"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: -w/--workspace, --to\n",
    2,
  ],
  [
    ["extra", "-x"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: -w/--workspace, --to\n",
    2,
  ],
  [
    ["-w", "W"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: name, --to\n",
    2,
  ],
  [
    ["--to", "T", "x"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: -w/--workspace\n",
    2,
  ],
  [
    ["-w", "W", "--to", "T"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: name\n",
    2,
  ],
  [
    ["-w", "W", "x", "--to", "T"],
    "{'workspace': 'W', 'name': 'x', 'to': 'T', 'yes': False}\n",
    "",
    0,
  ],
  [
    ["-w", "W", "x", "--to", "T", "--yes", "extra"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: unrecognized arguments: extra\n",
    2,
  ],
  [
    ["--to", "T", "-w"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: argument -w/--workspace: expected one argument\n",
    2,
  ],
  [
    ["-1"],
    "",
    "usage: test_argparse.ts [-h] -w WORKSPACE --to TO [--yes] name\ntest_argparse.ts: error: the following arguments are required: -w/--workspace, --to\n",
    2,
  ],
  [["-wW", "n", "--to=T"], "{'workspace': 'W', 'name': 'n', 'to': 'T', 'yes': False}\n", "", 0],
  [
    ["--work", "W", "--to", "T", "n"],
    "{'workspace': 'W', 'name': 'n', 'to': 'T', 'yes': False}\n",
    "",
    0,
  ],
];

// Optional-positional fixture: `data_dir` (nargs="?"), `-o/--output` (default "out.js"),
// `--check` store_true, declared in that order.
const OPT_USAGE = "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]";
const OPT_HELP =
  "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\n\nFixture optional-positional parser for scripts/_argparse.ts.\n\npositional arguments:\n  data_dir             optional positional\n\noptions:\n  -h, --help           show this help message and exit\n  -o, --output OUTPUT  takes a value\n  --check              a switch\n";
const OPTIONAL_POSITIONAL: [string[], string, string, number][] = [
  [[], "{'data_dir': None, 'output': 'out.js', 'check': False}\n", "", 0],
  [["d"], "{'data_dir': 'd', 'output': 'out.js', 'check': False}\n", "", 0],
  [
    ["d", "e"],
    "",
    "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\ntest_argparse.ts: error: unrecognized arguments: e\n",
    2,
  ],
  [["-o", "x", "d"], "{'data_dir': 'd', 'output': 'x', 'check': False}\n", "", 0],
  [["d", "-o", "x"], "{'data_dir': 'd', 'output': 'x', 'check': False}\n", "", 0],
  [
    ["-o", "x", "d", "e"],
    "",
    "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\ntest_argparse.ts: error: unrecognized arguments: e\n",
    2,
  ],
  [["--check"], "{'data_dir': None, 'output': 'out.js', 'check': True}\n", "", 0],
  [
    ["d", "--check", "e"],
    "",
    "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\ntest_argparse.ts: error: unrecognized arguments: e\n",
    2,
  ],
  [["-o", "x"], "{'data_dir': None, 'output': 'x', 'check': False}\n", "", 0],
  [
    ["-x", "d"],
    "",
    "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\ntest_argparse.ts: error: unrecognized arguments: -x\n",
    2,
  ],
  [["-1"], "{'data_dir': '-1', 'output': 'out.js', 'check': False}\n", "", 0],
  [["--check", "-o", "x", "d"], "{'data_dir': 'd', 'output': 'x', 'check': True}\n", "", 0],
  [
    ["d", "-o"],
    "",
    "usage: test_argparse.ts [-h] [-o OUTPUT] [--check] [data_dir]\ntest_argparse.ts: error: argument -o/--output: expected one argument\n",
    2,
  ],
];

// type=int (ArgSpec 5th element): conversion errors come when the value is consumed.
const INT_USAGE = "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n";
const INT_HELP =
  "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\n\nFixture type=int parser for scripts/_argparse.ts.\n\npositional arguments:\n  n              type=int positional\n\noptions:\n  -h, --help     show this help message and exit\n  --input INPUT  required value\n  --chunk CHUNK  type=int option\n  --yes          a switch\n";
const INT_TYPE: [string[], string, string, number][] = [
  [
    [],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: the following arguments are required: --input, n\n",
    2,
  ],
  [
    ["-h"],
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\n\nFixture type=int parser for scripts/_argparse.ts.\n\npositional arguments:\n  n              type=int positional\n\noptions:\n  -h, --help     show this help message and exit\n  --input INPUT  required value\n  --chunk CHUNK  type=int option\n  --yes          a switch\n",
    "",
    0,
  ],
  [
    ["--chunk", "x"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: 'x'\n",
    2,
  ],
  [
    ["--chunk", "x", "--bogus"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: 'x'\n",
    2,
  ],
  [
    ["--bogus", "--chunk", "x"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: 'x'\n",
    2,
  ],
  [
    ["--input", "i", "--chunk", "5", "7"],
    "{'input': 'i', 'chunk': 5, 'yes': False, 'n': 7}\n",
    "",
    0,
  ],
  [["--input", "i", "7"], "{'input': 'i', 'chunk': None, 'yes': False, 'n': 7}\n", "", 0],
  [
    ["--input", "i", "--chunk", " 1_0 ", "7"],
    "{'input': 'i', 'chunk': 10, 'yes': False, 'n': 7}\n",
    "",
    0,
  ],
  [
    ["--input", "i", "--chunk=-3", "7"],
    "{'input': 'i', 'chunk': -3, 'yes': False, 'n': 7}\n",
    "",
    0,
  ],
  [
    ["--chunk", "-1", "--input", "i", "1"],
    "{'input': 'i', 'chunk': -1, 'yes': False, 'n': 1}\n",
    "",
    0,
  ],
  [
    ["--input", "i", "--chunk", "1.5", "7"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: '1.5'\n",
    2,
  ],
  [
    ["--input", "i", "abc"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument n: invalid int value: 'abc'\n",
    2,
  ],
  [
    ["--input", "i", "abc", "--bogus"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument n: invalid int value: 'abc'\n",
    2,
  ],
  [
    ["7"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: the following arguments are required: --input\n",
    2,
  ],
  [
    ["--input", "i", "--chunk", "5"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: the following arguments are required: n\n",
    2,
  ],
  [
    ["--chunk", "5"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: the following arguments are required: --input, n\n",
    2,
  ],
  [
    ["--input", "i", "7", "8"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: unrecognized arguments: 8\n",
    2,
  ],
  [
    ["--input", "i", "--chunk", "x", "--chunk", "5", "7"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: 'x'\n",
    2,
  ],
  [
    ["--chunk", "5", "--chunk", "6", "--input", "i", "--yes", "7"],
    "{'input': 'i', 'chunk': 6, 'yes': True, 'n': 7}\n",
    "",
    0,
  ],
  [
    ["--input", "i", "--chunk", "٣", "7"],
    "{'input': 'i', 'chunk': 3, 'yes': False, 'n': 7}\n",
    "",
    0,
  ],
  [
    ["--chunk"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: expected one argument\n",
    2,
  ],
  [
    ["--ch", "x"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: 'x'\n",
    2,
  ],
  [
    ["--chunk=", "--input", "i", "7"],
    "",
    "usage: test_argparse.ts [-h] --input INPUT [--chunk CHUNK] [--yes] n\ntest_argparse.ts: error: argument --chunk: invalid int value: ''\n",
    2,
  ],
];

class Exit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

function run(
  argv: string[],
  group?: [string, string, boolean],
  fixture: "" | "required" | "optional" | "int" = "",
): [string, string, number] {
  let out = "";
  let err = "";
  const saved = [process.stdout.write, process.stderr.write, process.exit] as const;
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Exit(code ?? 0);
  }) as typeof process.exit;
  let status = 0;
  try {
    const ns =
      fixture === "int"
        ? parse_args(
            INT_USAGE,
            INT_HELP,
            [
              ["--input", "store", "input", true],
              ["--chunk", "store", "chunk", false, "int"],
              ["--yes", "store_true", "yes"],
              ["n", "store", "n", true, "int"],
            ],
            { input: null, chunk: null, yes: false, n: null },
            argv,
          )
        : fixture === "optional"
          ? parse_args(
              OPT_USAGE,
              OPT_HELP,
              [
                ["data_dir", "store", "data_dir", false],
                ["-o/--output", "store", "output"],
                ["--check", "store_true", "check"],
              ],
              { data_dir: null, output: "out.js", check: false },
              argv,
            )
          : fixture === "required"
            ? parse_args(
                REQ_USAGE,
                REQ_HELP,
                [
                  ["-w/--workspace", "store", "workspace", true],
                  ["name", "store", "name"],
                  ["--to", "store", "to", true],
                  ["--yes", "store_true", "yes"],
                ],
                { workspace: null, name: null, to: null, yes: false },
                argv,
              )
            : group
              ? parse_args(
                  group[0],
                  group[1],
                  [
                    ["--tool-input", "store_true", "tool_input"],
                    ["--staged", "store_true", "staged"],
                  ],
                  { tool_input: false, staged: false },
                  argv,
                  [{ required: group[2], dests: ["tool_input", "staged"] }],
                )
              : parse_args(
                  USAGE,
                  HELP,
                  [
                    ["-f/--flag", "store_true", "flag"],
                    ["-o/--opt", "store", "opt"],
                    ["--option-two", "append", "option_two"],
                    ["name", "store", "name"],
                  ],
                  { flag: false, opt: null, option_two: null, name: null },
                  argv,
                );
    out += py_repr(ns) + "\n";
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    status = e.status;
  } finally {
    [process.stdout.write, process.stderr.write, process.exit] = saved;
  }
  return [out, err, status];
}

let failures = 0;
const check = (
  label: string,
  got: [string, string, number],
  expected: [string, string, number],
): void => {
  if (Bun.deepEquals(got, expected, true)) console.log(`✅ ${label}`);
  else {
    failures++;
    console.log(`❌ ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
};
for (const [argv, stdout, stderr, status] of CASES) {
  check(`parse_args(${JSON.stringify(argv)})`, run(argv), [stdout, stderr, status]);
}
for (const [required, cases] of [
  [true, GROUP_REQUIRED],
  [false, GROUP_OPTIONAL],
] as const) {
  const usage = required ? GROUP_USAGE : GROUP_USAGE_OPT;
  const help = required ? GROUP_HELP : GROUP_HELP_OPT;
  for (const [argv, stdout, stderr, status] of cases) {
    check(
      `group(required=${required}) ${JSON.stringify(argv)}`,
      run(argv, [usage, help, required]),
      [stdout, stderr, status],
    );
  }
}
for (const [argv, stdout, stderr, status] of REQUIRED_OPTIONS) {
  check(`required options ${JSON.stringify(argv)}`, run(argv, undefined, "required"), [
    stdout,
    stderr,
    status,
  ]);
}
for (const [argv, stdout, stderr, status] of OPTIONAL_POSITIONAL) {
  check(`optional positional ${JSON.stringify(argv)}`, run(argv, undefined, "optional"), [
    stdout,
    stderr,
    status,
  ]);
}

for (const [argv, stdout, stderr, status] of INT_TYPE) {
  check(`type=int ${JSON.stringify(argv)}`, run(argv, undefined, "int"), [stdout, stderr, status]);
}

process.exit(failures ? 1 : 0);
