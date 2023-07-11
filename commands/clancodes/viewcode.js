const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
var appRoot = require('app-root-path');
var db = require(appRoot + '/database.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('viewcode')
		.setDescription('View information about a code.')
        .addStringOption(option =>
			option
				.setName('code')
                .setRequired(true)
				.setDescription('The code you want to get info of.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
	async execute(interaction) {
        const code = interaction.options.getString('code');
        let msg = await addCode(code);
        await interaction.reply({ content: msg, ephemeral: true });
	},
};

async function addCode(code) {
	try {
		const res = await db.pool.query("INSERT INTO codes (code) VALUES ($1);", [code]);
        return "Code added to bank."
	} catch (error) {
		console.error(error);
        return "Something went wrong while trying to get info for this code.";
	}
}
