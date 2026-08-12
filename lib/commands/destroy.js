const Baker          = require('../modules/baker');
const conf           = require('../../lib/modules/configstore');
const Print          = require('../modules/print');
const Spinner        = require('../modules/spinner');
const spinnerDot     = conf.get('spinnerDot');

exports.command = ['delete [VMName]', 'destroy [VMName]'];
exports.desc = `remove an environment and it's associated files`;
exports.builder = (yargs) => {
    yargs
        .example(`$0 destroy`, `Destroys the environment from baker.yml of current directory`)
        .example(`$0 destroy baker-test`, `Destroys baker-test environment`);

    // TODO: bakePath is required for finding the envType.
    // for now assuming the command is executed in same dir as baker.yml
    // yargs.positional('envName', {
    //         describe: 'Name of the environment to be destroyed',
    //         type: 'string'
    //     });
}

exports.handler = async function(argv) {
    try {
        let bakePath = process.cwd();
        const {envName, BakerObj} = await Baker.chooseProvider(bakePath);

        await Spinner.spinPromise(BakerObj.delete(envName), `Destroying VM: ${envName}`, spinnerDot);
        // destroy tears down the environment; it never touches what the
        // bakelets put on the machine. Someone reaching for destroy is usually
        // reaching for both.
        Print.info(`Injected files remain; run 'baker cleanup' to remove them.`);
    } catch (err) {
        Print.error(err);
    }
}
