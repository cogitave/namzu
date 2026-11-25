// Writes a lot to stdout the way a command does, then leaves through the same helper the command
// shell uses. argv[2] is the byte count, argv[3] the exit code.
import { flushStdio } from '../flush-stdio.js'

const bytes = Number(process.argv[2])
const code = Number(process.argv[3])
process.stdout.write('x'.repeat(bytes - 1))
process.stdout.write('\n')
await flushStdio()
process.exit(code)
