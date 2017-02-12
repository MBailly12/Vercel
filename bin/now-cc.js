#!/usr/bin/env node

// Native
const {resolve} = require('path')

// Packages
const chalk = require('chalk')
const minimist = require('minimist')
const ms = require('ms')
const inquirer = require('inquirer')

// Ours
const login = require('../lib/login')
const cfg = require('../lib/cfg')
const {error} = require('../lib/error')
const NowCreditCards = require('../lib/credit-cards')
const indent = require('../lib/indent')

const argv = minimist(process.argv.slice(2), {
  string: ['config', 'token'],
  boolean: ['help', 'debug'],
  alias: {
    help: 'h',
    config: 'c',
    debug: 'd',
    token: 't'
  }
})

const subcommand = argv._[0]

const help = () => {
  console.log(`
  ${chalk.bold('𝚫 now cc')} <ls | add | rm | set-default>

  ${chalk.dim('Options:')}

    -h, --help              Output usage information
    -c ${chalk.bold.underline('FILE')}, --config=${chalk.bold.underline('FILE')}  Config file
    -d, --debug             Debug mode [off]
    -f, --force             Skip DNS verification
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline('TOKEN')} Login token

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} Lists all your credit cards:

      ${chalk.cyan('$ now cc ls')}

  ${chalk.gray('–')} Adds a credit card (interactively):

      ${chalk.cyan(`$ now cc add`)}

  ${chalk.gray('–')} Removes a credit card:

      ${chalk.cyan(`$ now cc rm <id>`)}

      ${chalk.gray('–')} If the id is ommitted, you can choose interactively

  ${chalk.gray('–')} Selects your default credit card:

      ${chalk.cyan(`$ now cc set-default <id>`)}

      ${chalk.gray('–')} If the id is ommitted, you can choose interactively
  `)
}

// options
const debug = argv.debug
const apiUrl = argv.url || 'https://api.zeit.co'

if (argv.config) {
  cfg.setConfigFile(argv.config)
}

const exit = code => {
  // we give stdout some time to flush out
  // because there's a node bug where
  // stdout writes are asynchronous
  // https://github.com/nodejs/node/issues/6456
  setTimeout(() => process.exit(code || 0), 100)
}

if (argv.help || !subcommand) {
  help()
  exit(0)
} else {
  const config = cfg.read()

  Promise.resolve(argv.token || config.token || login(apiUrl))
  .then(async token => {
    try {
      await run(token)
    } catch (err) {
      if (err.userError) {
        error(err.message)
      } else {
        error(`Unknown error: ${err.stack}`)
      }
      exit(1)
    }
  })
  .catch(e => {
    error(`Authentication error – ${e.message}`)
    exit(1)
  })
}

// Builds a `choices` object that can be passesd to inquirer.prompt()
function buildInquirerChoices(cards) {
  return cards.cards.map(card => {
    const _default = card.id === cards.defaultCardId ? ' ' + chalk.bold('(default)') : ''
    const id = `${chalk.cyan(`ID: ${card.id}`)}${_default}`
    const number = `${chalk.gray('#### ').repeat(3)}${card.last4}`
    const str = [
      id,
      indent(card.name, 2),
      indent(`${card.brand} ${number}`, 2)
    ].join('\n')

    return {
      name: str, // Will be displayed by Inquirer
      value: card.id, // Will be used to identify the answer
      short: card.id // Will be displayed after the users answers
    }
  }).reduce((prev, curr) => prev.concat(new inquirer.Separator(' '), curr), [])
}

async function run(token) {
  const start = new Date()
  const creditCards = new NowCreditCards(apiUrl, token, {debug})
  const args = argv._.slice(1)

  switch (subcommand) {
    case 'ls':
    case 'list': {
      const cards = await creditCards.ls()
      const text = cards.cards.map(card => {
        const _default = card.id === cards.defaultCardId ? ' ' + chalk.bold('(default)') : ''
        const id = `${chalk.gray('-')} ${chalk.cyan(`ID: ${card.id}`)}${_default}`
        const number = `${chalk.gray('#### ').repeat(3)}${card.last4}`
        let address = card.address_line1

        if (card.address_line2) {
          address += `, ${card.address_line2}.`
        } else {
          address += '.'
        }

        address += `\n${card.address_city}, `

        if (card.address_state) {
          address += `${card.address_state}, `
        }

        // TODO: Stripe is returning a two digit code for the country,
        // but we want the full country name
        address += `${card.address_zip}. ${card.address_country}`

        return [
          id,
          indent(card.name, 2),
          indent(`${card.brand} ${number}`, 2),
          indent(address, 2)
        ].join('\n')
      }).join('\n\n')

      const elapsed = ms(new Date() - start)
      console.log(`> ${cards.cards.length} card${cards.cards.length === 1 ? '' : 's'} found ${chalk.gray(`[${elapsed}]`)}`)
      if (text) {
        console.log(`\n${text}\n`)
      }

      break
    }

    case 'set-default': {
      if (args.length > 1) {
        error('Invalid number of arguments')
        return exit(1)
      }

      const start = new Date()
      const cards = await creditCards.ls()

      if (cards.cards.length === 0) {
        error('You have no credit cards to choose from')
        return exit(0)
      }

      const ANSWER_NAME = 'now-cc-set-default'
      let cardId = args[0]

      if (cardId === undefined) {
        const choices = buildInquirerChoices(cards)
        choices.push(new inquirer.Separator())
        choices.push({
          name: 'Abort',
          value: undefined
        })

        const elapsed = ms(new Date() - start)
        const message = `Selecting a new default payment card from ${cards.cards.length} total ${chalk.gray(`[${elapsed}]`)}`
        const answer = await inquirer.prompt({
          name: ANSWER_NAME,
          type: 'list',
          message,
          choices,
          pageSize: 15 // Show 15 lines without scrolling (~4 credit cards)
        })

        cardId = answer[ANSWER_NAME]
      }

      // TODO: check if the provided cardId (in case the user
      // typed `now cc set-default <some-id>`) is valid
      if (cardId) {
        const start = new Date()
        await creditCards.setDefault(cardId)

        const card = cards.cards.find(card => card.id === cardId)
        const elapsed = ms(new Date() - start)
        const text = `${chalk.cyan('Success!')} ${card.brand} ending in ${card.last4} is now the default ${chalk.gray(`[${elapsed}]`)}`

        console.log(text)
      } else {
        console.log('No changes made')
      }

      break
    }

    case 'rm':
    case 'remove': {
      if (args.length > 1) {
        error('Invalid number of arguments')
        return exit(1)
      }

      const start = new Date()
      const cards = await creditCards.ls()

      if (cards.cards.length === 0) {
        error('You have no credit cards to choose from to delete')
        return exit(0)
      }

      const ANSWER_NAME = 'now-cc-rm'
      let cardId = args[0]

      if (cardId === undefined) {
        const choices = buildInquirerChoices(cards)
        const blankSeparator = choices.shift()

        choices.unshift(new inquirer.Separator())
        choices.unshift({
          name: 'Abort',
          value: undefined
        })
        choices.unshift(blankSeparator)

        const elapsed = ms(new Date() - start)
        const message = `Selecting a card to ${chalk.underline('remove')} from ${cards.cards.length} total ${chalk.gray(`[${elapsed}]`)}`
        const answer = await inquirer.prompt({
          name: ANSWER_NAME,
          type: 'list',
          message,
          choices,
          pageSize: 15 // Show 15 lines without scrolling (~4 credit cards)
        })

        cardId = answer[ANSWER_NAME]
      }

      // TODO: check if the provided cardId (in case the user
      // typed `now cc rm <some-id>`) is valid
      if (cardId) {
        const start = new Date()
        await creditCards.rm(cardId)

        const deletedCard = cards.cards.find(card => card.id === cardId)
        const remainingCards = cards.cards.filter(card => card.id !== cardId)

        let text = `${chalk.cyan('Success!')} ${deletedCard.brand} ending in ${deletedCard.last4} was deleted`
        //  ${chalk.gray(`[${elapsed}]`)}

        if (cardId === cards.defaultCardId) {
          if (remainingCards.length === 0) {
            // The user deleted the last card in their account
            text += `\n${chalk.yellow('Warning!')} You have no default card`
          } else {
            // We can't guess the current default card – let's ask the API
            const cards = await creditCards.ls()
            const newDefaultCard = cards.cards.find(card => card.id === cards.defaultCardId)

            text += `\n${newDefaultCard.brand} ending in ${newDefaultCard.last4} in now default`
          }
        }

        const elapsed = ms(new Date() - start)
        text += ` ${chalk.gray(`[${elapsed}]`)}`
        console.log(text)
      } else {
        console.log('No changes made')
      }

      break
    }

    case 'add': {
      require(resolve(__dirname, 'now-cc-add.js'))(creditCards)

      break
    }

    default:
      error('Please specify a valid subcommand: ls | add | rm | set-default')
      help()
      exit(1)
  }

  creditCards.close()
}
