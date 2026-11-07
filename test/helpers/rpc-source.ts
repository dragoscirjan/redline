/** Source-RPC tests stay independent of package builds. Package tests exercise installed launchers. */
import { main } from '../../src/rpc/main.ts';

process.exitCode = await main();
