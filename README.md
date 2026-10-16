# Agenda API

![CI](https://github.com/araujohjessica/agenda-api/actions/workflows/ci.yml/badge.svg)

API REST de agendamento online para profissionais autônomos (consultórios, terapeutas, aulas): página pública de agendamento, área do cliente, painel da profissional e controle financeiro.

🖥️ **Frontend:** [agenda](https://github.com/araujohjessica/agenda)

## Destaques

- **110 testes end-to-end** cobrindo autenticação, regras de agendamento, notificações e financeiro, rodando no GitHub Actions a cada push
- **Geração automática de horários:** a profissional define períodos (datas, dias da semana, faixa de horário, intervalo e duração) e a API cria os horários, ignorando os que já passaram ou já existem
- **Regras de negócio no servidor:** antecedência mínima para agendar, prazo limite para cancelar ou remarcar e agenda pausável
- **Sem agendamento duplo:** índice único parcial no banco garante uma única consulta confirmada por horário, mesmo com requisições simultâneas
- **Login do cliente sem senha:** código de 6 dígitos por e-mail, guardado com hash, com expiração de 10 minutos, limite de 5 tentativas e intervalo mínimo de reenvio
- **Agendamento sem cadastro:** o cliente agenda só com nome e e-mail e pode criar a senha depois
- **Notificações por e-mail** de confirmação, remarcação e cancelamento, para o cliente e para a profissional
- **Arquivo `.ics`** para adicionar a consulta ao calendário
- **Financeiro:** recebido, a receber, inadimplência, faltas, despesas, resultado líquido, ocupação da agenda, comparação com o período anterior, série mensal, ranking de clientes e exportação CSV pronta para o Excel
- **Histórico preservado:** horários e locais com consultas antigas são desativados em vez de apagados

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js (ES Modules) |
| Framework | Express |
| Banco | SQLite (better-sqlite3, modo WAL, chaves estrangeiras) |
| Autenticação | JWT + bcrypt |
| Validação | Joi |
| Segurança | Helmet |
| E-mail | Nodemailer |

## Estrutura

```
src/
├── server.js          # Express, middlewares e rotas
├── db.js              # schema e migrações
├── routes/            # auth, public, appointments, professional, finance
├── services/          # agendamentos, notificações e e-mail
├── middleware/        # autenticação e papéis
└── utils/             # datas (horário de Brasília) e respostas HTTP
scripts/
├── seed.js                 # dados de exemplo
├── e2e.js                  # testes end-to-end
├── create-professional.js  # cria a conta da profissional
└── backup.js               # cópia de segurança do banco
```

## Rotas principais

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/auth/login` · `/register` | Login e cadastro |
| POST | `/api/auth/client/request-code` · `/verify-code` | Acesso do cliente por código no e-mail |
| GET | `/api/public/professionals/:slug` | Perfil público, locais e valor |
| GET | `/api/public/professionals/:slug/slots` | Horários livres |
| POST | `/api/public/professionals/:slug/appointments` | Agendamento sem cadastro |
| GET | `/api/appointments` | Consultas do usuário logado |
| POST | `/api/appointments/:id/cancel` · `/reschedule` | Cancelar e remarcar |
| GET | `/api/appointments/:id/ics` | Arquivo de calendário |
| GET/PUT | `/api/professional/settings` | Regras e dados da agenda |
| CRUD | `/api/professional/locations` · `/periods` · `/slots` | Locais, períodos e horários |
| PATCH | `/api/professional/appointments/:id/status` | Realizada ou falta |
| GET | `/api/professional/dashboard` · `/clients` | Painel e clientes |
| GET | `/api/professional/finance/summary` · `/monthly` · `/top-clients` | Indicadores financeiros |
| GET | `/api/professional/finance/export.csv` | Exportação para Excel |

## Como executar

```bash
git clone https://github.com/araujohjessica/agenda-api.git
cd agenda-api
npm install
cp .env.example .env
npm run seed
npm run dev
```

A API sobe em `http://localhost:4100`. Sem configuração de e-mail, as mensagens aparecem no console.

```bash
npm test   # roda os testes end-to-end
```

## Autora

**Jessica Helena Araujo**, engenheira da computação, JA Developers · [GitHub](https://github.com/araujohjessica) · [LinkedIn](https://www.linkedin.com/in/jessica-araujo-89b328279/)