const { SlashCommandBuilder } = require('discord.js');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('banksize')
		.setDescription('Shows how many codes are in the bank.'),
	async execute(interaction) {
		await interaction.reply('There are 0 codes in the bank.');
	},
};