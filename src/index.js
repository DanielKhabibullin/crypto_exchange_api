const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')

const {
	readData,
	writeData,
	response,
	makeAccount,
	pregenerateMineCurrencies,
	premakeAccounts,
	formatAmount,
	generateAccountId,
	pregenerateHistory
} = require('./utils.js')

const app = express()
require('express-ws')(app)
const port = process.env.PORT || 3000

const AUTH_DATA = Object.freeze({
	login: 'developer',
	password: 'zxcvbn',
	token: 'QXF24GFxcJSnhTSmaxRsKa08'
})

const MINE_ACCOUNT = '24051911200915061003240821'

const KNOWN_OTHER_ACCOUNTS = Object.freeze([
	'20530478211782688256124528',
	'25103808305087276118446870',
	'87360872061730026356786724',
	'12508408027460025280024028',
	"7022200000250040",
	"2411553415544415",
])

const KNOWN_CURRENCY_CODES = Object.freeze([
	'ETH',
	'BTC',
	'USD',
	'EUR',
	'JPY',
	'GBP',
	'AUD',
	'CAD',
	'CHF',
	'CNH',
	'HKD',
	'NZD',
	'RUB',
	'UAH',
	'BYR'
])

let currencyFeedSubscribers = []

const data = readData()

pregenerateMineCurrencies(data, KNOWN_CURRENCY_CODES)
premakeAccounts(data, KNOWN_OTHER_ACCOUNTS)
pregenerateHistory(data, [ MINE_ACCOUNT ], true)

function authCheck(req, res, next) {
	if ((req.headers.authorization !== `Basic ${AUTH_DATA.token}`)) {
		res.end(response(null, 'Unauthorized'))
		return
	}
	next()
}

app.use(cors())
app.use(bodyParser.json())

app.get('/', (req, res) => {
  res.send('Backend is working')
})

app.post('/login', (req, res) => {
	const { login, password } = (req.body || {})

	if (login === AUTH_DATA.login) {
		if (password === AUTH_DATA.password) {
			res.end(response({ token: AUTH_DATA.token }))
		} else {
			res.end(response(null, 'Invalid password'))
		}
		return
	}

	res.end(response(null, 'No such user'))
})

app.get('/accounts', authCheck, (req, res) => {
	const myAccounts = Object.values(data.accounts).filter(account => account.mine).map(account => ({
		...account,
		transactions: [ account.transactions[ account.transactions.length - 1 ] ].filter(Boolean)
	}))
	res.end(response(myAccounts))
})

app.get('/account/:id', authCheck, (req, res) => {
	const myAccount = data.accounts[req.params.id]
	if (myAccount) {
		res.end(response(myAccount))
		return
	}
	res.end(response(null, 'No such account'))
})

app.post('/create-account', authCheck, (req, res) => {
	const newAccount = makeAccount(true);
	data.accounts[newAccount.account] = newAccount;
	writeData(data)
	res.end(response(newAccount))
})

app.post('/transfer-funds', authCheck, (req, res) => {
	const { from, to, amount: rawAmount } = (req.body || {})
	const fromAccount = data.accounts[from]
	let toAccount = data.accounts[to]
	const amount = Number(rawAmount)

	if (!fromAccount || !fromAccount.mine) {
		res.end(response(null, 'Invalid account from'))
		return
	}
	
	if (!toAccount) {
		if (Math.random() < 0.25) {
			toAccount = makeAccount(false, toAccount)
			data.accounts[to] = toAccount
		} else {
			res.end(response(null, 'Invalid account to'))
			return
		}
	}

	if (isNaN(amount) || amount < 0) {
		res.end(response(null, 'Invalid amount'))
		return
	}

	if (fromAccount.balance - amount < 0) {
		res.end(response(null, 'Overdraft prevented'))
		return
	}

	fromAccount.balance -= amount;
	toAccount.balance += amount;

	const transactionTime = (new Date()).toISOString()
	fromAccount.transactions.push({
		date: transactionTime,
		from: fromAccount.account,
		to: toAccount.account,
		amount,
	})
	toAccount.transactions.push({
		date: transactionTime,
		from: fromAccount.account,
		to: toAccount.account,
		amount,
	})
	
	writeData(data)

	res.end(response(fromAccount))
})

app.get('/all-currencies', (req, res) => {
	res.end(response(KNOWN_CURRENCY_CODES))
})

app.ws('/currency-feed', (ws, req) => {
	currencyFeedSubscribers.push(ws)
	ws.on('close', () => {
		currencyFeedSubscribers = currencyFeedSubscribers.filter(websocket => websocket !== ws)
	})
})

app.get('/currencies', authCheck, (req, res) => {
	const myCurrencies = data.mine.currencies || {}
	res.end(response(myCurrencies))
})

app.post('/currency-buy', authCheck, (req, res) => {
	const { from, to, amount: rawAmount } = (req.body || {})
	const myCurrencies = data.mine.currencies || {}

	const amount = Number(rawAmount)

	if (!KNOWN_CURRENCY_CODES.includes(from) || !KNOWN_CURRENCY_CODES.includes(to)) {
		res.end(response(null, 'Unknown currency code'))
		return
	}

	if (isNaN(amount) || amount < 0) {
		res.end(response(null, 'Invalid amount'))
		return
	}

	const fromCurrency = myCurrencies[from]
	const toCurrency = myCurrencies[to] = (myCurrencies[to] || {
		"amount": 0,
		"code": to
	})

	if (!fromCurrency || !fromCurrency.amount) {
		res.end(response(null, 'Not enough currency'))
		return
	}

	const exchangeRate = getExchangeRate(from, to) || 1

	if (fromCurrency.amount - amount < 0) {
		res.end(response(null, 'Overdraft prevented'))
		return
	}

	fromCurrency.amount -= amount
	toCurrency.amount += amount * exchangeRate

	writeData(data)

	res.end(response(myCurrencies))
})


app.post('*', (req, res) => {
	res.end(response(null, 'Invalid route'))
})

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})


function setExchangeRate(currency1, currency2, rate) {
	const existingInverseRate = data.exchange[`${currency2}/${currency1}`]
	if (existingInverseRate) {
		data.exchange[`${currency2}/${currency1}`] = formatAmount(1 / rate)
		return
	}
	data.exchange[`${currency1}/${currency2}`] = rate
}

function getExchangeRate(currency1, currency2) {
	const straightRate = Number(data.exchange[`${currency1}/${currency2}`])
	if (!isNaN(straightRate)) {
		return straightRate
	}
	const inverseRate = data.exchange[`${currency2}/${currency1}`]
	if (inverseRate) {
		return 1/inverseRate
	}
	return 0
}

const currencyRateFeedGenerator = setInterval(() => {
	// generate currency exchange rate change
	const currenciesLength = KNOWN_CURRENCY_CODES.length
	const index1 = Math.floor(Math.random() * currenciesLength)
	let index2 = Math.floor(Math.random() * currenciesLength)
	if (index1 === index2) {
		index2 = (index2 + 1) % currenciesLength
	}
	const from = KNOWN_CURRENCY_CODES[index1]
	const to = KNOWN_CURRENCY_CODES[index2]
	const rate = formatAmount(0.001 + Math.random() * 100)
	const previousExchangeRate = getExchangeRate(from, to)
	const change = rate > previousExchangeRate ? 1 : rate < previousExchangeRate ? -1 : 0
	setExchangeRate(from, to, rate)
	writeData(data)
	currencyFeedSubscribers.forEach(subscriber => subscriber.send(
		JSON.stringify({
			type: 'EXCHANGE_RATE_CHANGE',
			from,
			to,
			rate,
			change
		})
	))

	// pick random user account and generate random transaction for it
	if (Math.random() > 0.9) {
		const account = data.accounts[MINE_ACCOUNT]
		const amount = formatAmount(Math.random() * 1000)
		account.balance = formatAmount(account.balance + amount)
		account.transactions.push({
			amount,
			date: (new Date()).toISOString(),
			from: generateAccountId(),
			to: MINE_ACCOUNT
		})
		writeData(data)
	}
}, 1000)
currencyRateFeedGenerator.unref()
