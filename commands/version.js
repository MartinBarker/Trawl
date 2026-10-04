const { SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trawl-version')
        .setDescription('Display the current bot version'),
    async execute(interaction) {
        try {
            // Read package.json to get the version
            const packagePath = path.join(__dirname, '..', 'package.json');
            const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            
            const version = packageData.version || 'Unknown';
            const name = packageData.name || 'Discord Bot';
            
            await interaction.reply({
                content: `🤖 **${name}**\n📦 Version: \`${version}\``,
                ephemeral: true
            });
            
            console.log(`Version command executed - Version: ${version}`);
        } catch (error) {
            console.error('Error reading package.json:', error);
            await interaction.reply({
                content: '❌ Error retrieving bot version.',
                ephemeral: true
            });
        }
    },
};
