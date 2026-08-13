#!/usr/bin/env node
const yargs = require('yargs');
const { homepage, version } = require('./package.json');

yargs
  .commandDir('./lib/commands')
  .version()
  .epilog(
      (homepage ? `| Homepage: ${homepage}\n` : '') +
      (`| Documentation: https://github.com/chbrown13/Baker/tree/main/docs\n`) +
      (version ? `| Version: ${version}` : '')
    )
  .demandCommand(1, 'Did you forget to specify a command?')
  .recommendCommands()
  .showHelpOnFail(false, 'Specify --help for available options')
  .strict(true)
  .help()
  .wrap(yargs.terminalWidth())
  .argv
