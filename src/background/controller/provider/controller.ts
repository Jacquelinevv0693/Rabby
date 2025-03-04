import * as Sentry from '@sentry/browser';
import Transaction from 'ethereumjs-tx';
import Common, { Hardfork } from '@ethereumjs/common';
import {
  TransactionFactory,
  FeeMarketEIP1559Transaction,
} from '@ethereumjs/tx';
import { ethers } from 'ethers';
import {
  bufferToHex,
  isHexString,
  addHexPrefix,
  intToHex,
} from 'ethereumjs-util';
import { stringToHex } from 'web3-utils';
import { ethErrors } from 'eth-rpc-errors';
import {
  normalize as normalizeAddress,
  recoverPersonalSignature,
} from 'eth-sig-util';
import cloneDeep from 'lodash/cloneDeep';
import {
  keyringService,
  permissionService,
  sessionService,
  openapiService,
  preferenceService,
  transactionWatchService,
  transactionHistoryService,
  pageStateCacheService,
  signTextHistoryService,
  i18n,
} from 'background/service';
import { notification } from 'background/webapi';
import { Session } from 'background/service/session';
import { Tx } from 'background/service/openapi';
import RpcCache from 'background/utils/rpcCache';
import Wallet from '../wallet';
import {
  CHAINS,
  CHAINS_ENUM,
  SAFE_RPC_METHODS,
  KEYRING_TYPE,
  KEYRING_CATEGORY_MAP,
} from 'consts';
import buildinProvider from 'background/utils/buildinProvider';
import BaseController from '../base';
import { Account } from 'background/service/preference';
import {
  validateGasPriceRange,
  is1559Tx,
  convert1559ToLegacy,
} from '@/utils/transaction';
import stats from '@/stats';

interface ApprovalRes extends Tx {
  type?: string;
  address?: string;
  uiRequestComponent?: string;
  isSend?: boolean;
  isSpeedUp?: boolean;
  isCancel?: boolean;
  isGnosis?: boolean;
  account?: Account;
  extra?: Record<string, any>;
  traceId?: string;
}

interface Web3WalletPermission {
  // The name of the method corresponding to the permission
  parentCapability: string;

  // The date the permission was granted, in UNIX epoch time
  date?: number;
}

const v1SignTypedDataVlidation = ({
  data: {
    params: [_, from],
  },
}) => {
  const currentAddress = preferenceService
    .getCurrentAccount()
    ?.address.toLowerCase();
  if (from.toLowerCase() !== currentAddress)
    throw ethErrors.rpc.invalidParams('from should be same as current address');
};

const signTypedDataVlidation = ({
  data: {
    params: [from, _],
  },
}) => {
  const currentAddress = preferenceService
    .getCurrentAccount()
    ?.address.toLowerCase();
  if (from.toLowerCase() !== currentAddress)
    throw ethErrors.rpc.invalidParams('from should be same as current address');
};

class ProviderController extends BaseController {
  ethRpc = (req, forceChainServerId?: string) => {
    const {
      data: { method, params },
      session: { origin },
    } = req;

    if (
      !permissionService.hasPermission(origin) &&
      !SAFE_RPC_METHODS.includes(method)
    ) {
      throw ethErrors.provider.unauthorized();
    }

    const site = permissionService.getSite(origin);
    let chainServerId = CHAINS[CHAINS_ENUM.ETH].serverId;
    if (site) {
      chainServerId = CHAINS[site.chain].serverId;
    }
    if (forceChainServerId) {
      chainServerId = forceChainServerId;
    }

    const currentAddress =
      preferenceService.getCurrentAccount()?.address.toLowerCase() || '0x';
    const cache = RpcCache.get(currentAddress, {
      method,
      params,
      chainId: chainServerId,
    });
    if (cache) return cache;

    const promise = openapiService
      .ethRpc(chainServerId, {
        origin: encodeURIComponent(origin),
        method,
        params,
      })
      .then((result) => {
        RpcCache.set(currentAddress, {
          method,
          params,
          result,
          chainId: chainServerId,
        });
        return result;
      });
    RpcCache.set(currentAddress, {
      method,
      params,
      result: promise,
      chainId: chainServerId,
    });
    return promise;
  };

  ethRequestAccounts = async ({ session: { origin } }) => {
    if (!permissionService.hasPermission(origin)) {
      throw ethErrors.provider.unauthorized();
    }

    const _account = await this.getCurrentAccount();
    const account = _account ? [_account.address.toLowerCase()] : [];
    sessionService.broadcastEvent('accountsChanged', account);
    const connectSite = permissionService.getConnectedSite(origin);
    if (connectSite) {
      const chain = CHAINS[connectSite.chain];
      sessionService.broadcastEvent(
        'chainChanged',
        {
          chain: chain.hex,
          networkVersion: chain.network,
        },
        origin
      );
    }

    return account;
  };

  @Reflect.metadata('SAFE', true)
  ethAccounts = async ({ session: { origin } }) => {
    if (!permissionService.hasPermission(origin) || !Wallet.isUnlocked()) {
      return [];
    }

    const account = await this.getCurrentAccount();
    return account ? [account.address.toLowerCase()] : [];
  };

  ethCoinbase = async ({ session: { origin } }) => {
    if (!permissionService.hasPermission(origin)) {
      return null;
    }

    const account = await this.getCurrentAccount();
    return account ? account.address.toLowerCase() : null;
  };

  @Reflect.metadata('SAFE', true)
  ethChainId = ({ session }: { session: Session }) => {
    const origin = session.origin;
    const site = permissionService.getWithoutUpdate(origin);

    return CHAINS[site?.chain || CHAINS_ENUM.ETH].hex;
  };

  @Reflect.metadata('APPROVAL', [
    'SignTx',
    ({
      data: {
        params: [tx],
      },
      session,
    }) => {
      const currentAddress = preferenceService
        .getCurrentAccount()
        ?.address.toLowerCase();
      const currentChain = permissionService.isInternalOrigin(session.origin)
        ? Object.values(CHAINS).find((chain) => chain.id === tx.chainId)!.enum
        : permissionService.getConnectedSite(session.origin)?.chain;
      if (tx.from.toLowerCase() !== currentAddress) {
        throw ethErrors.rpc.invalidParams(
          'from should be same as current address'
        );
      }
      if (
        'chainId' in tx &&
        (!currentChain || Number(tx.chainId) !== CHAINS[currentChain].id)
      ) {
        throw ethErrors.rpc.invalidParams(
          'chainId should be same as current chainId'
        );
      }
    },
  ])
  ethSendTransaction = async (options: {
    data: {
      params: any;
    };
    session: Session;
    approvalRes: ApprovalRes;
    pushed: boolean;
    result: any;
  }) => {
    if (options.pushed) return options.result;
    const {
      data: {
        params: [txParams],
      },
      session: { origin },
      approvalRes,
    } = cloneDeep(options);
    const keyring = await this._checkAddress(txParams.from);
    const isSend = !!txParams.isSend;
    const isSpeedUp = !!txParams.isSpeedUp;
    const isCancel = !!txParams.isCancel;
    const traceId = approvalRes.traceId;
    const extra = approvalRes.extra;
    let signedTransactionSuccess = false;
    delete txParams.isSend;
    delete approvalRes.isSend;
    delete approvalRes.address;
    delete approvalRes.type;
    delete approvalRes.uiRequestComponent;
    delete approvalRes.traceId;
    delete approvalRes.extra;
    let tx;
    let is1559 = is1559Tx(approvalRes);
    if (is1559) {
      if (approvalRes.maxFeePerGas === approvalRes.maxPriorityFeePerGas) {
        // fallback to legacy transaction if maxFeePerGas is equal to maxPriorityFeePerGas
        tx = new Transaction(convert1559ToLegacy(approvalRes));
        is1559 = false;
        approvalRes.gasPrice = approvalRes.maxFeePerGas;
        delete approvalRes.maxFeePerGas;
        delete approvalRes.maxPriorityFeePerGas;
      } else {
        const common = Common.custom(
          { chainId: approvalRes.chainId },
          { hardfork: Hardfork.London }
        );
        tx = FeeMarketEIP1559Transaction.fromTxData(
          { ...approvalRes, gasLimit: approvalRes.gas } as any,
          {
            common,
          }
        );
      }
    } else {
      tx = new Transaction(approvalRes);
    }
    const currentAccount = preferenceService.getCurrentAccount()!;
    let opts;
    opts = extra;
    if (currentAccount.type === KEYRING_TYPE.GnosisKeyring) {
      buildinProvider.currentProvider.currentAccount = approvalRes!.account!.address;
      buildinProvider.currentProvider.currentAccountType = approvalRes!.account!.type;
      buildinProvider.currentProvider.currentAccountBrand = approvalRes!.account!.brandName;
      try {
        const provider = new ethers.providers.Web3Provider(
          buildinProvider.currentProvider
        );
        opts = {
          provider,
        };
      } catch (e) {
        console.log(e);
      }
    }
    const chain = permissionService.isInternalOrigin(origin)
      ? Object.values(CHAINS).find((chain) => chain.id === approvalRes.chainId)!
          .enum
      : permissionService.getConnectedSite(origin)!.chain;
    try {
      const signedTx = await keyringService.signTransaction(
        keyring,
        tx,
        txParams.from,
        opts
      );
      if (currentAccount.type === KEYRING_TYPE.GnosisKeyring) {
        signedTransactionSuccess = true;
        stats.report('signedTransaction', {
          type: currentAccount.brandName,
          chainId: CHAINS[chain].serverId,
          category: KEYRING_CATEGORY_MAP[currentAccount.type],
          success: true,
        });
        return;
      }
      const onTranscationSubmitted = (hash: string) => {
        const cacheExplain = transactionHistoryService.getExplainCache({
          address: txParams.from,
          chainId: Number(approvalRes.chainId),
          nonce: Number(approvalRes.nonce),
        });
        stats.report('submitTransaction', {
          type: currentAccount.brandName,
          chainId: CHAINS[chain].serverId,
          category: KEYRING_CATEGORY_MAP[currentAccount.type],
          success: true,
        });
        if (isSend) {
          pageStateCacheService.clear();
        }
        transactionHistoryService.addTx(
          {
            rawTx: approvalRes,
            createdAt: Date.now(),
            isCompleted: false,
            hash,
            failed: false,
          },
          cacheExplain
        );
        transactionWatchService.addTx(
          `${txParams.from}_${approvalRes.nonce}_${chain}`,
          {
            nonce: approvalRes.nonce,
            hash,
            chain,
          }
        );
      };
      if (typeof signedTx === 'string') {
        onTranscationSubmitted(signedTx);
        return signedTx;
      }
      let buildTx;
      if (is1559) {
        buildTx = FeeMarketEIP1559Transaction.fromTxData({
          ...(approvalRes as any),
          r: addHexPrefix(signedTx.r),
          s: addHexPrefix(signedTx.s),
          v: addHexPrefix(signedTx.v),
        });
      } else {
        buildTx = TransactionFactory.fromTxData({
          ...approvalRes,
          r: addHexPrefix(signedTx.r),
          s: addHexPrefix(signedTx.s),
          v: addHexPrefix(signedTx.v),
        });
      }

      // Report address type(not sensitive information) to sentry when tx signatuure is invalid
      if (!buildTx.verifySignature()) {
        if (!buildTx.v) {
          Sentry.captureException(new Error(`v missed, ${keyring.type}`));
        } else if (!buildTx.s) {
          Sentry.captureException(new Error(`s missed, ${keyring.type}`));
        } else if (!buildTx.r) {
          Sentry.captureException(new Error(`r missed, ${keyring.type}`));
        } else {
          Sentry.captureException(
            new Error(`invalid signature, ${keyring.type}`)
          );
        }
      }
      signedTransactionSuccess = true;
      stats.report('signedTransaction', {
        type: currentAccount.brandName,
        chainId: CHAINS[chain].serverId,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        success: true,
      });
      try {
        validateGasPriceRange(approvalRes);
        const hash = await openapiService.pushTx(
          {
            ...approvalRes,
            r: bufferToHex(signedTx.r),
            s: bufferToHex(signedTx.s),
            v: bufferToHex(signedTx.v),
            value: approvalRes.value || '0x0',
          },
          traceId
        );

        onTranscationSubmitted(hash);
        return hash;
      } catch (e: any) {
        stats.report('submitTransaction', {
          type: currentAccount.brandName,
          chainId: CHAINS[chain].serverId,
          category: KEYRING_CATEGORY_MAP[currentAccount.type],
          success: false,
        });
        if (!isSpeedUp && !isCancel) {
          const cacheExplain = transactionHistoryService.getExplainCache({
            address: txParams.from,
            chainId: Number(approvalRes.chainId),
            nonce: Number(approvalRes.nonce),
          });
          transactionHistoryService.addSubmitFailedTransaction(
            {
              rawTx: approvalRes,
              createdAt: Date.now(),
              isCompleted: true,
              hash: '',
              failed: false,
              isSubmitFailed: true,
            },
            cacheExplain
          );
        }
        const errMsg = e.message || JSON.stringify(e);
        notification.create(
          undefined,
          i18n.t('Transaction push failed'),
          errMsg
        );
        throw new Error(errMsg);
      }
    } catch (e) {
      if (!signedTransactionSuccess) {
        stats.report('signedTransaction', {
          type: currentAccount.brandName,
          chainId: CHAINS[chain].serverId,
          category: KEYRING_CATEGORY_MAP[currentAccount.type],
          success: false,
        });
      }
      throw new Error(e);
    }
  };
  @Reflect.metadata('SAFE', true)
  netVersion = (req) => {
    return this.ethRpc({
      ...req,
      data: { method: 'net_version', params: [] },
    });
  };

  @Reflect.metadata('SAFE', true)
  web3ClientVersion = () => {
    return `Rabby/${process.env.release}`;
  };

  @Reflect.metadata('APPROVAL', [
    'SignText',
    ({
      data: {
        params: [_, from],
      },
    }) => {
      const currentAddress = preferenceService
        .getCurrentAccount()
        ?.address.toLowerCase();
      if (from.toLowerCase() !== currentAddress)
        throw ethErrors.rpc.invalidParams(
          'from should be same as current address'
        );
    },
  ])
  personalSign = async ({ data, approvalRes, session }) => {
    if (!data.params) return;
    const currentAccount = preferenceService.getCurrentAccount()!;
    try {
      const [string, from] = data.params;
      const hex = isHexString(string) ? string : stringToHex(string);
      const keyring = await this._checkAddress(from);
      const result = await keyringService.signPersonalMessage(
        keyring,
        { data: hex, from },
        approvalRes?.extra
      );
      signTextHistoryService.createHistory({
        address: from,
        text: string,
        origin: session.origin,
        type: 'personalSign',
      });
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'personalSign',
        success: true,
      });
      return result;
    } catch (e) {
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'personalSign',
        success: false,
      });
      throw e;
    }
  };

  private _signTypedData = async (from, data, version, extra?) => {
    const keyring = await this._checkAddress(from);
    let _data = data;
    if (version !== 'V1') {
      if (typeof data === 'string') {
        _data = JSON.parse(data);
      }
    }

    return keyringService.signTypedMessage(
      keyring,
      { from, data: _data },
      { version, ...(extra || {}) }
    );
  };

  @Reflect.metadata('APPROVAL', ['SignTypedData', v1SignTypedDataVlidation])
  ethSignTypedData = async ({
    data: {
      params: [data, from],
    },
    session,
    approvalRes,
  }) => {
    const currentAccount = preferenceService.getCurrentAccount()!;
    try {
      const result = await this._signTypedData(
        from,
        data,
        'V1',
        approvalRes?.extra
      );
      signTextHistoryService.createHistory({
        address: from,
        text: data,
        origin: session.origin,
        type: 'ethSignTypedData',
      });
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedData',
        success: true,
      });
      return result;
    } catch (e) {
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedData',
        success: false,
      });
      throw e;
    }
  };

  @Reflect.metadata('APPROVAL', ['SignTypedData', v1SignTypedDataVlidation])
  ethSignTypedDataV1 = async ({
    data: {
      params: [data, from],
    },
    session,
    approvalRes,
  }) => {
    const currentAccount = preferenceService.getCurrentAccount()!;
    try {
      const result = await this._signTypedData(
        from,
        data,
        'V1',
        approvalRes?.extra
      );
      signTextHistoryService.createHistory({
        address: from,
        text: data,
        origin: session.origin,
        type: 'ethSignTypedDataV1',
      });
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV1',
        success: true,
      });
      return result;
    } catch (e) {
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV1',
        success: false,
      });
      throw e;
    }
  };

  @Reflect.metadata('APPROVAL', ['SignTypedData', signTypedDataVlidation])
  ethSignTypedDataV3 = async ({
    data: {
      params: [from, data],
    },
    session,
    approvalRes,
  }) => {
    const currentAccount = preferenceService.getCurrentAccount()!;
    try {
      const result = await this._signTypedData(
        from,
        data,
        'V3',
        approvalRes?.extra
      );
      signTextHistoryService.createHistory({
        address: from,
        text: data,
        origin: session.origin,
        type: 'ethSignTypedDataV3',
      });
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV3',
        success: true,
      });
      return result;
    } catch (e) {
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV3',
        success: false,
      });
      throw e;
    }
  };

  @Reflect.metadata('APPROVAL', ['SignTypedData', signTypedDataVlidation])
  ethSignTypedDataV4 = async ({
    data: {
      params: [from, data],
    },
    session,
    approvalRes,
  }) => {
    const currentAccount = preferenceService.getCurrentAccount()!;
    try {
      const result = await this._signTypedData(
        from,
        data,
        'V4',
        approvalRes?.extra
      );
      signTextHistoryService.createHistory({
        address: from,
        text: data,
        origin: session.origin,
        type: 'ethSignTypedDataV4',
      });
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV4',
        success: true,
      });
      return result;
    } catch (e) {
      stats.report('completeSignText', {
        type: currentAccount.brandName,
        category: KEYRING_CATEGORY_MAP[currentAccount.type],
        method: 'ethSignTypedDataV4',
        success: false,
      });
      throw e;
    }
  };

  @Reflect.metadata('APPROVAL', [
    'AddChain',
    ({ data, session }) => {
      const connected = permissionService.getConnectedSite(session.origin);
      if (connected) {
        const { chainId } = data.params[0];
        if (Number(chainId) === CHAINS[connected.chain].id) {
          return true;
        }
      }
    },
    { height: 390 },
  ])
  walletAddEthereumChain = ({
    data: {
      params: [chainParams],
    },
    session: { origin },
  }) => {
    let chainId = chainParams.chainId;
    if (typeof chainId === 'number') {
      chainId = intToHex(chainId).toLowerCase();
    } else {
      chainId = chainId.toLowerCase();
    }
    const chain = Object.values(CHAINS).find((value) => value.hex === chainId);

    if (!chain) {
      throw new Error('This chain is not supported by Rabby yet.');
    }

    permissionService.updateConnectSite(
      origin,
      {
        chain: chain.enum,
      },
      true
    );

    sessionService.broadcastEvent(
      'chainChanged',
      {
        chain: chain.hex,
        networkVersion: chain.network,
      },
      origin
    );
    return null;
  };

  @Reflect.metadata('APPROVAL', [
    'AddChain',
    ({ data, session }) => {
      const connected = permissionService.getConnectedSite(session.origin);
      if (connected) {
        const { chainId } = data.params[0];
        if (Number(chainId) === CHAINS[connected.chain].id) {
          return true;
        }
      }
    },
    { height: 390 },
  ])
  walletSwitchEthereumChain = this.walletAddEthereumChain;

  @Reflect.metadata('APPROVAL', ['AddAsset', () => null, { height: 390 }])
  walletWatchAsset = () => {
    throw new Error(
      'Rabby does not support adding tokens in this way for now.'
    );
  };

  walletRequestPermissions = ({ data: { params: permissions } }) => {
    const result: Web3WalletPermission[] = [];
    if (permissions && 'eth_accounts' in permissions[0]) {
      result.push({ parentCapability: 'eth_accounts' });
    }
    return result;
  };

  @Reflect.metadata('SAFE', true)
  walletGetPermissions = ({ session: { origin } }) => {
    const result: Web3WalletPermission[] = [];
    if (Wallet.isUnlocked() && Wallet.getConnectedSite(origin)) {
      result.push({ parentCapability: 'eth_accounts' });
    }
    return result;
  };

  personalEcRecover = ({
    data: {
      params: [data, sig, extra = {}],
    },
  }) => {
    return recoverPersonalSignature({
      ...extra,
      data,
      sig,
    });
  };

  @Reflect.metadata('SAFE', true)
  netListening = () => {
    return true;
  };

  private _checkAddress = async (address) => {
    // eslint-disable-next-line prefer-const
    let { address: currentAddress, type } =
      (await this.getCurrentAccount()) || {};
    currentAddress = currentAddress?.toLowerCase();
    if (
      !currentAddress ||
      currentAddress !== normalizeAddress(address).toLowerCase()
    ) {
      throw ethErrors.rpc.invalidParams({
        message:
          'Invalid parameters: must use the current user address to sign',
      });
    }
    const keyring = await keyringService.getKeyringForAccount(
      currentAddress,
      type
    );

    return keyring;
  };

  @Reflect.metadata('APPROVAL', [
    'GetPublicKey',
    ({
      data: {
        params: [address],
      },
      session: { origin },
    }) => {
      const account = preferenceService.getCurrentAccount();

      if (address?.toLowerCase() !== account?.address?.toLowerCase()) {
        throw ethErrors.rpc.invalidParams({
          message:
            'Invalid parameters: must use the current user address to sign',
        });
      }
    },
    { height: 390 },
  ])
  ethGetEncryptionPublicKey = async ({
    data: {
      params: [address],
    },
    session: { origin },
    approvalRes,
  }) => {
    return approvalRes?.data;
  };

  @Reflect.metadata('APPROVAL', [
    'Decrypt',
    ({
      data: {
        params: [message, address],
      },
      session: { origin },
    }) => {
      return null;
    },
  ])
  ethDecrypt = async ({
    data: {
      params: [message, address],
    },
    session: { origin },
    approvalRes,
  }) => {
    return approvalRes.data;
  };
}

export default new ProviderController();
