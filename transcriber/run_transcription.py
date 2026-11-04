import json
import sys
from pathlib import Path


def main() -> int:
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('input.wav')
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('transcript.json')

    payload = {
        "source": str(input_path),
        "segments": [],
        "status": "stubbed",
    }

    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Arquivo de transcrição gerado em {output_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
