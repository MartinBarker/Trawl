// /trawl-makeplaylists — scan a channel, persist every music link to Postgres, and
// post a signed magic link to the results page on martinbarker.me where the
// user can connect YouTube and push the tracks to their own playlist.
const { SlashCommandBuilder, ChannelType } = require('discord.js');
const { scanChannel } = require('../lib/scan');
const { issueMagicToken } = require('../lib/magicToken');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trawl-makeplaylists')
    .setDescription('Scan a channel for music links and get a link to add them to a YouTube playlist')
    .addChannelOption(o =>
      o.setName('input_channel')
        .setDescription('Channel to scan (defaults to the current channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false))
    .addChannelOption(o =>
      o.setName('output_channel')
        .setDescription('Channel to post the results link in (defaults to input channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const inputChannel = interaction.options.getChannel('input_channel') || interaction.channel;
    const outputChannel = interaction.options.getChannel('output_channel') || inputChannel;

    if (!interaction.guild) {
      return interaction.editReply('This command must be used in a server.');
    }
    if (!inputChannel || inputChannel.type !== ChannelType.GuildText) {
      return interaction.editReply('Input channel must be a text channel.');
    }
    if (!outputChannel || outputChannel.type !== ChannelType.GuildText) {
      return interaction.editReply('Output channel must be a text channel.');
    }

    // Permission checks.
    const inPerms = inputChannel.permissionsFor(interaction.client.user);
    if (!inPerms?.has('ViewChannel') || !inPerms?.has('ReadMessageHistory')) {
      return interaction.editReply('I need **View Channel** + **Read Message History** in the input channel.');
    }
    const outPerms = outputChannel.permissionsFor(interaction.client.user);
    if (!outPerms?.has('ViewChannel') || !outPerms?.has('SendMessages')) {
      return interaction.editReply('I need **View Channel** + **Send Messages** in the output channel.');
    }

    try {
      const { scanJobId, newCount, totalCount } = await scanChannel({
        inputChannel,
        outputChannel,
        guild: interaction.guild,
        initiatedByUserId: interaction.user.id,
      });

      const token = await issueMagicToken(scanJobId, interaction.user.id);
      const siteOrigin = process.env.SITE_ORIGIN || 'https://martinbarker.me';
      const url = `${siteOrigin}/trawl/results/${scanJobId}?t=${token}`;

      await outputChannel.send(
        `Found **${totalCount}** track${totalCount === 1 ? '' : 's'}` +
        (newCount ? ` (**${newCount}** new)` : '') +
        `. **[View & add to YouTube →](${url})**`
      );

      await interaction.editReply(
        `Scan complete — ${totalCount} total link${totalCount === 1 ? '' : 's'}, ${newCount} new. ` +
        `Posted the results link in ${outputChannel}.`
      );
    } catch (err) {
      console.error('/trawl-makeplaylists failed:', err);
      await interaction.editReply(`Scan failed: ${err.message}`);
    }
  },
};
