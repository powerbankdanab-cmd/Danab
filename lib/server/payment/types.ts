export type Battery = {
  battery_id: string;
  slot_id: string;
  lock_status: string;
  battery_capacity: string;
  battery_abnormal: string;
  cable_abnormal: string;
  battery_status?: string;
  slot_status?: string;
  battery_soh?: string;
};

export type WaafiParams = {
  accountNo?: string;
  accountType?: string;
  state?: string;
  merchantCharges?: string;
  transactionId?: string;
  issuerTransactionId?: string;
  referenceId?: string;
  txAmount?: string;
};

export type WaafiResponse = {
  schemaVersion?: string;
  timestamp?: string;
  responseId?: string;
  responseCode?: string | number;
  errorCode?: string;
  responseMsg?: string;
  params?: WaafiParams;
};

export type PaymentInput = {
  phoneNumber: string;
  amount: number;
  stationCode?: string;
};

export type PaymentSuccessPayload = {
  success: true;
  battery_id: string;
  slot_id: string;
  unlock: unknown;
  waafiMessage: string;
  waafiResponse: WaafiResponse;
};

export type PaymentDuplicatePayload = {
  success: true;
  message: string;
  transactionId: string;
};

export type PaymentPayload = PaymentSuccessPayload | PaymentDuplicatePayload;
