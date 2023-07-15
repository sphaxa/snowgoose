const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
var appRoot = require('app-root-path');
var db = require(appRoot + '/database.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('addcode')
		.setDescription('Add an invite code to the bank.')
        .addStringOption(option =>
			option
				.setName('code')
                .setRequired(true)
				.setDescription('The code you want to add to the bank.'))
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
        return "Something went wrong trying to add this code, make sure it's not a duplicate (Use /viewcode).";
	}
}