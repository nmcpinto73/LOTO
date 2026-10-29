/* ============================================================================
   LoTo — configuração do servidor
   ----------------------------------------------------------------------------
   Preencha os dois valores abaixo e faça novo commit para o GitHub Pages.
   Onde os encontrar: Supabase → Project Settings → API
     • Project URL      -> supabaseUrl   (SÓ o domínio: https://ID.supabase.co)
       NÃO inclua /rest/v1/ nem /auth/v1 — a app acrescenta esses caminhos.
     • anon public key  -> supabaseAnonKey   (é pública, pode ficar no código)

   Se deixar vazio, a app funciona em MODO LOCAL (só neste telemóvel),
   exactamente como antes.
   ============================================================================ */
window.LOTO_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',

  // Nome que aparece no cabeçalho
  empresa: 'EuroResinas',

  // Segundos entre sincronizações automáticas
  intervalo: 20
};
